/**
 * BetterDesk Console - Self-Update Service
 *
 * Checks GitHub for new releases, compares with local version, downloads
 * only changed files, creates a backup before applying, and restarts the
 * console service.
 *
 * GitHub repo:  UNITRONIX/Rustdesk-FreeConsole
 * Version file: VERSION (root of repo)
 *
 * Flow:
 *   1. GET /repos/{owner}/{repo}/releases/latest → remote version
 *   2. Compare with local VERSION / package.json
 *   3. GET /repos/{owner}/{repo}/compare/{localTag}...{remoteTag} → changed files
 *   4. Download each changed file (only web-nodejs/ subtree)
 *   5. Backup current files → data/backups/pre-update-{ts}/
 *   6. Overwrite local files
 *   7. Restart service via process exit (systemd restarts automatically)
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');
const config = require('../config/config');

const GITHUB_OWNER = process.env.UPDATE_GITHUB_OWNER || 'UNITRONIX';
const GITHUB_REPO  = process.env.UPDATE_GITHUB_REPO  || 'Rustdesk-FreeConsole';
const GITHUB_API   = 'https://api.github.com';
const CONSOLE_PREFIX = 'web-nodejs/';
const USER_AGENT   = `BetterDesk-Console/${config.appVersion}`;
const BACKUP_DIR   = path.join(config.dataDir, 'backups');
const ROOT_DIR     = path.join(__dirname, '..');

// Optional GitHub token for higher rate limits (60/h unauthenticated, 5000/h with token)
const GITHUB_TOKEN = process.env.UPDATE_GITHUB_TOKEN || '';

// ======================== Helpers ========================================

/**
 * Make an HTTPS GET request and return parsed JSON.
 */
function ghGet(urlPath) {
    return new Promise((resolve, reject) => {
        const url = urlPath.startsWith('https://') ? new URL(urlPath) : new URL(urlPath, GITHUB_API);
        const headers = {
            'User-Agent': USER_AGENT,
            'Accept': 'application/vnd.github+json'
        };
        if (GITHUB_TOKEN) headers['Authorization'] = `Bearer ${GITHUB_TOKEN}`;

        const req = https.get({ hostname: url.hostname, path: url.pathname + url.search, headers }, (res) => {
            if (res.statusCode === 301 || res.statusCode === 302) {
                return ghGet(res.headers.location).then(resolve, reject);
            }
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                const body = Buffer.concat(chunks).toString();
                if (res.statusCode >= 400) {
                    return reject(new Error(`GitHub API ${res.statusCode}: ${body.slice(0, 200)}`));
                }
                try { resolve(JSON.parse(body)); }
                catch (e) { reject(new Error('Invalid JSON from GitHub API')); }
            });
        });
        req.on('error', reject);
        req.setTimeout(15000, () => { req.destroy(); reject(new Error('GitHub API timeout')); });
    });
}

/**
 * Download raw file content from GitHub.
 */
function ghDownloadFile(owner, repo, ref, filePath) {
    return new Promise((resolve, reject) => {
        const url = `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${filePath}`;
        const headers = { 'User-Agent': USER_AGENT };
        if (GITHUB_TOKEN) headers['Authorization'] = `Bearer ${GITHUB_TOKEN}`;

        const req = https.get(url, { headers }, (res) => {
            if (res.statusCode === 301 || res.statusCode === 302) {
                return ghDownloadFile(owner, repo, ref, filePath).then(resolve, reject);
            }
            if (res.statusCode !== 200) {
                return reject(new Error(`Download failed (${res.statusCode}): ${filePath}`));
            }
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve(Buffer.concat(chunks)));
        });
        req.on('error', reject);
        req.setTimeout(30000, () => { req.destroy(); reject(new Error(`Download timeout: ${filePath}`)); });
    });
}

/**
 * Parse semver-like version string → comparable integer.
 * "3.0.0" → 3000000, "2.4.1" → 2004001
 */
function versionToInt(v) {
    const parts = String(v).replace(/^v/i, '').split('.').map(Number);
    return (parts[0] || 0) * 1000000 + (parts[1] || 0) * 1000 + (parts[2] || 0);
}

/**
 * Get local version from VERSION file or package.json.
 */
function getLocalVersion() {
    // Try VERSION file at console root
    const versionFile = path.join(ROOT_DIR, '..', 'VERSION');
    if (fs.existsSync(versionFile)) {
        const v = fs.readFileSync(versionFile, 'utf8').trim();
        if (v) return v;
    }
    return config.appVersion;
}

// ======================== Public API ====================================

/**
 * Check for updates — returns version info without downloading anything.
 */
async function checkForUpdates() {
    const localVersion = getLocalVersion();

    // Fetch latest release from GitHub
    const release = await ghGet(`/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`);
    const remoteVersion = (release.tag_name || '').replace(/^v/i, '');

    const isNewer = versionToInt(remoteVersion) > versionToInt(localVersion);

    return {
        localVersion,
        remoteVersion,
        isNewer,
        releaseName: release.name || `v${remoteVersion}`,
        releaseUrl: release.html_url || '',
        publishedAt: release.published_at || '',
        changelog: release.body || '',
        prerelease: release.prerelease || false
    };
}

/**
 * Get list of changed console files between local and remote versions.
 * Uses GitHub Compare API to get a diff of only web-nodejs/ files.
 */
async function getChangedFiles(localVersion, remoteVersion) {
    const localTag = `v${localVersion.replace(/^v/i, '')}`;
    const remoteTag = `v${remoteVersion.replace(/^v/i, '')}`;

    let files;
    try {
        const compare = await ghGet(`/repos/${GITHUB_OWNER}/${GITHUB_REPO}/compare/${localTag}...${remoteTag}`);
        files = (compare.files || []);
    } catch (_err) {
        // If tags don't exist, fall back to getting the tree for remote tag
        // and comparing with local files manually
        const tree = await ghGet(`/repos/${GITHUB_OWNER}/${GITHUB_REPO}/git/trees/${remoteTag}?recursive=1`);
        files = (tree.tree || [])
            .filter(f => f.type === 'blob' && f.path.startsWith(CONSOLE_PREFIX))
            .map(f => ({ filename: f.path, status: 'modified', sha: f.sha }));
    }

    // Filter to only web-nodejs/ files and exclude tests/dev files
    const consoleFiles = files.filter(f => {
        if (!f.filename.startsWith(CONSOLE_PREFIX)) return false;
        // Skip test files, node_modules references, etc.
        const rel = f.filename.slice(CONSOLE_PREFIX.length);
        if (rel.startsWith('node_modules/')) return false;
        if (rel.startsWith('test/') || rel.startsWith('tests/')) return false;
        if (rel === 'package-lock.json') return false;
        return true;
    });

    return consoleFiles.map(f => ({
        path: f.filename,                        // full path in repo (web-nodejs/...)
        localPath: f.filename.slice(CONSOLE_PREFIX.length),  // relative to console root
        status: f.status || 'modified',          // added | modified | removed | renamed
        sha: f.sha || ''
    }));
}

/**
 * Create a pre-update backup of files that will be changed.
 * Returns the backup directory path.
 */
async function createPreUpdateBackup(changedFiles) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const backupPath = path.join(BACKUP_DIR, `pre-update-${ts}`);

    fs.mkdirSync(backupPath, { recursive: true });

    // Save VERSION
    const localVersion = getLocalVersion();
    fs.writeFileSync(path.join(backupPath, 'VERSION.txt'), localVersion);

    // Backup each file that will be changed
    let backedUp = 0;
    for (const file of changedFiles) {
        const src = path.join(ROOT_DIR, file.localPath);
        if (fs.existsSync(src)) {
            const dest = path.join(backupPath, file.localPath);
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            fs.copyFileSync(src, dest);
            backedUp++;
        }
    }

    // Save manifest
    fs.writeFileSync(path.join(backupPath, 'manifest.json'), JSON.stringify({
        version: localVersion,
        timestamp: new Date().toISOString(),
        filesBackedUp: backedUp,
        files: changedFiles.map(f => f.localPath)
    }, null, 2));

    return { backupPath, backedUp };
}

/**
 * Apply update — download changed files from GitHub and overwrite local copies.
 * Returns summary of applied changes.
 */
async function applyUpdate(remoteVersion, changedFiles, createBackup = true) {
    const ref = `v${remoteVersion.replace(/^v/i, '')}`;

    // 1. Backup
    let backupInfo = null;
    if (createBackup) {
        backupInfo = await createPreUpdateBackup(changedFiles);
    }

    // 2. Download and apply each file
    const applied = [];
    const failed = [];
    const removed = [];

    for (const file of changedFiles) {
        try {
            if (file.status === 'removed') {
                // Delete local file
                const localFile = path.join(ROOT_DIR, file.localPath);
                if (fs.existsSync(localFile)) {
                    fs.unlinkSync(localFile);
                    removed.push(file.localPath);
                }
                continue;
            }

            // Download from GitHub
            const content = await ghDownloadFile(GITHUB_OWNER, GITHUB_REPO, ref, file.path);
            const dest = path.join(ROOT_DIR, file.localPath);

            // Ensure directory exists
            fs.mkdirSync(path.dirname(dest), { recursive: true });

            // Write file
            fs.writeFileSync(dest, content);
            applied.push(file.localPath);
        } catch (err) {
            failed.push({ file: file.localPath, error: err.message });
        }
    }

    // 3. Update package.json version if needed
    try {
        const pkgPath = path.join(ROOT_DIR, 'package.json');
        if (fs.existsSync(pkgPath)) {
            const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
            if (pkg.version !== remoteVersion.replace(/^v/i, '')) {
                pkg.version = remoteVersion.replace(/^v/i, '');
                fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
            }
        }
    } catch (_e) { /* non-critical */ }

    // 4. Check if package.json dependencies changed → run npm install
    let npmInstalled = false;
    if (changedFiles.some(f => f.localPath === 'package.json')) {
        try {
            execSync('npm install --omit=dev --no-audit --no-fund', {
                cwd: ROOT_DIR,
                timeout: 120000,
                stdio: 'pipe'
            });
            npmInstalled = true;
        } catch (_e) {
            failed.push({ file: 'npm install', error: 'npm install failed — restart may fix this' });
        }
    }

    return {
        applied,
        failed,
        removed,
        npmInstalled,
        backupPath: backupInfo?.backupPath || null,
        backedUp: backupInfo?.backedUp || 0,
        totalChanged: changedFiles.length
    };
}

/**
 * List available pre-update backups.
 */
function listBackups() {
    if (!fs.existsSync(BACKUP_DIR)) return [];

    return fs.readdirSync(BACKUP_DIR)
        .filter(d => d.startsWith('pre-update-'))
        .map(d => {
            const dir = path.join(BACKUP_DIR, d);
            const manifestPath = path.join(dir, 'manifest.json');
            let manifest = {};
            if (fs.existsSync(manifestPath)) {
                try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch (_e) { /* skip */ }
            }
            return {
                name: d,
                path: dir,
                version: manifest.version || 'unknown',
                timestamp: manifest.timestamp || '',
                filesBackedUp: manifest.filesBackedUp || 0
            };
        })
        .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

/**
 * Restore from a pre-update backup.
 */
function restoreFromBackup(backupName) {
    const backupPath = path.join(BACKUP_DIR, backupName);
    if (!fs.existsSync(backupPath)) {
        throw new Error('Backup not found');
    }
    // Validate backup name to prevent directory traversal
    if (!/^pre-update-[\d\-T]+$/.test(backupName)) {
        throw new Error('Invalid backup name');
    }

    const manifestPath = path.join(backupPath, 'manifest.json');
    if (!fs.existsSync(manifestPath)) {
        throw new Error('Invalid backup — missing manifest');
    }

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    let restored = 0;

    for (const filePath of (manifest.files || [])) {
        const src = path.join(backupPath, filePath);
        const dest = path.join(ROOT_DIR, filePath);
        if (fs.existsSync(src)) {
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            fs.copyFileSync(src, dest);
            restored++;
        }
    }

    return { restored, version: manifest.version, totalFiles: (manifest.files || []).length };
}

module.exports = {
    checkForUpdates,
    getChangedFiles,
    createPreUpdateBackup,
    applyUpdate,
    listBackups,
    restoreFromBackup,
    getLocalVersion
};
