'use strict';

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const LANG_DIR = path.join(__dirname, '..', 'lang');
const REFERENCE = 'en.json';

/**
 * Recursively flatten nested JSON object into dot-notation keys
 */
function flattenKeys(obj, prefix = '') {
    const result = new Map();
    for (const [key, value] of Object.entries(obj)) {
        const fullKey = prefix ? `${prefix}.${key}` : key;
        if (value && typeof value === 'object' && !Array.isArray(value)) {
            for (const [k, v] of flattenKeys(value, fullKey)) {
                result.set(k, v);
            }
        } else {
            result.set(fullKey, String(value ?? ''));
        }
    }
    return result;
}

// --- Page Route ---

router.get('/languages', requireAuth, requireAdmin, (req, res) => {
    res.render('languages', {
        title: req.t('nav.languages'),
        pageStyles: ['languages'],
        pageScripts: ['languages'],
        currentPage: 'languages',
        breadcrumb: [{ label: req.t('nav.languages') }]
    });
});

// --- API Routes ---

/**
 * GET /api/panel/languages — List all languages with coverage stats
 */
router.get('/api/panel/languages', requireAuth, requireAdmin, (req, res) => {
    try {
        const refPath = path.join(LANG_DIR, REFERENCE);
        if (!fs.existsSync(refPath)) {
            return res.json({ languages: [], refKeyCount: 0 });
        }

        const refData = JSON.parse(fs.readFileSync(refPath, 'utf8'));
        const refKeys = flattenKeys(refData);
        const refKeySet = new Set(refKeys.keys());

        const langFiles = fs.readdirSync(LANG_DIR)
            .filter(f => f.endsWith('.json'))
            .sort();

        const languages = [];

        for (const file of langFiles) {
            const code = file.replace('.json', '');
            const filePath = path.join(LANG_DIR, file);

            let data;
            try {
                data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            } catch (e) {
                languages.push({
                    code,
                    name: code,
                    native: code,
                    flag: '',
                    rtl: false,
                    needs_review: true,
                    is_reference: code === 'en',
                    total_keys: 0,
                    missing_keys: refKeySet.size,
                    extra_keys: 0,
                    empty_keys: 0,
                    coverage: 0,
                    error: e.message
                });
                continue;
            }

            const meta = data._meta || {};
            const langKeys = flattenKeys(data);
            const langKeySet = new Set(langKeys.keys());

            const missing = [...refKeySet].filter(k => !langKeySet.has(k));
            const extra = [...langKeySet].filter(k => !refKeySet.has(k) && !k.startsWith('_meta'));
            const empty = [...langKeySet].filter(k => refKeySet.has(k) && langKeys.get(k) === '');

            const coverage = code === 'en' ? 100
                : refKeySet.size > 0
                    ? Math.round(((refKeySet.size - missing.length) / refKeySet.size) * 100)
                    : 100;

            languages.push({
                code,
                name: meta.name || code,
                native: meta.native_name || meta.name || code,
                flag: meta.flag || '',
                rtl: meta.rtl || false,
                needs_review: meta.needs_review || false,
                is_reference: code === 'en',
                total_keys: langKeySet.size,
                missing_keys: code === 'en' ? 0 : missing.length,
                extra_keys: extra.length,
                empty_keys: empty.length,
                coverage,
                error: null
            });
        }

        res.json({ languages, refKeyCount: refKeySet.size });
    } catch (err) {
        res.status(500).json({ error: 'Failed to load languages' });
    }
});

/**
 * GET /api/panel/languages/:code/missing — Get missing keys for a language
 */
router.get('/api/panel/languages/:code/missing', requireAuth, requireAdmin, (req, res) => {
    try {
        const code = req.params.code.replace(/[^a-z-]/gi, '');
        const refPath = path.join(LANG_DIR, REFERENCE);
        const langPath = path.join(LANG_DIR, `${code}.json`);

        if (!fs.existsSync(langPath)) {
            return res.status(404).json({ error: 'Language not found' });
        }

        const refData = JSON.parse(fs.readFileSync(refPath, 'utf8'));
        const langData = JSON.parse(fs.readFileSync(langPath, 'utf8'));

        const refKeys = flattenKeys(refData);
        const langKeys = flattenKeys(langData);
        const refKeySet = new Set(refKeys.keys());
        const langKeySet = new Set(langKeys.keys());

        const missing = [...refKeySet].filter(k => !langKeySet.has(k)).map(k => ({
            key: k,
            en_value: refKeys.get(k)
        }));

        const extra = [...langKeySet].filter(k => !refKeySet.has(k) && !k.startsWith('_meta'));

        res.json({ code, missing, extra, total: refKeySet.size });
    } catch (err) {
        res.status(500).json({ error: 'Failed to analyze language' });
    }
});

/**
 * POST /api/panel/languages/:code/fix — Add missing keys with EN fallback
 */
router.post('/api/panel/languages/:code/fix', requireAuth, requireAdmin, (req, res) => {
    try {
        const code = req.params.code.replace(/[^a-z-]/gi, '');
        if (code === 'en') {
            return res.status(400).json({ error: 'Cannot fix reference language' });
        }

        const refPath = path.join(LANG_DIR, REFERENCE);
        const langPath = path.join(LANG_DIR, `${code}.json`);

        if (!fs.existsSync(langPath)) {
            return res.status(404).json({ error: 'Language not found' });
        }

        const refData = JSON.parse(fs.readFileSync(refPath, 'utf8'));
        const langData = JSON.parse(fs.readFileSync(langPath, 'utf8'));

        const refKeys = flattenKeys(refData);
        const langKeys = flattenKeys(langData);
        const refKeySet = new Set(refKeys.keys());
        const langKeySet = new Set(langKeys.keys());

        const missing = [...refKeySet].filter(k => !langKeySet.has(k));

        if (missing.length === 0) {
            return res.json({ fixed: 0 });
        }

        // Set missing keys with EN fallback
        for (const key of missing) {
            const parts = key.split('.');
            let current = langData;
            for (let i = 0; i < parts.length - 1; i++) {
                if (!(parts[i] in current) || typeof current[parts[i]] !== 'object') {
                    current[parts[i]] = {};
                }
                current = current[parts[i]];
            }
            current[parts[parts.length - 1]] = refKeys.get(key);
        }

        fs.writeFileSync(langPath, JSON.stringify(langData, null, 2) + '\n', 'utf8');

        res.json({ fixed: missing.length });
    } catch (err) {
        res.status(500).json({ error: 'Failed to fix language' });
    }
});

module.exports = router;
