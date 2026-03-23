/**
 * BetterDesk Console - Desktop Widget Layout Routes
 * Persists per-user widget layouts and wallpaper selection server-side.
 */

const express = require('express');
const router = express.Router();
const db = require('../services/database');
const { requireAuth } = require('../middleware/auth');
const path = require('path');
const fs = require('fs');

/* ── Key helpers ────────────────────────────────────────────── */

const LAYOUT_KEY_PREFIX = 'desktop_layout_';
const WALLPAPER_KEY_PREFIX = 'desktop_wallpaper_';

function layoutKey(userId) { return LAYOUT_KEY_PREFIX + userId; }
function wallpaperKey(userId) { return WALLPAPER_KEY_PREFIX + userId; }

/* ── Maximum payload size (512 KB) ──────────────────────────── */
const MAX_LAYOUT_SIZE = 512 * 1024;

/* ── Validation ─────────────────────────────────────────────── */

function isValidWidgetArray(arr) {
    if (!Array.isArray(arr)) return false;
    if (arr.length > 100) return false; // max 100 widgets
    for (const w of arr) {
        if (!w || typeof w !== 'object') return false;
        if (typeof w.id !== 'string' || w.id.length > 40) return false;
        if (typeof w.type !== 'string' || w.type.length > 60) return false;
        if (typeof w.x !== 'number' || typeof w.y !== 'number') return false;
        if (typeof w.w !== 'number' || typeof w.h !== 'number') return false;
    }
    return true;
}

function isValidWallpaperPath(p) {
    if (typeof p !== 'string') return false;
    if (p.length > 100) return false;
    // Only allow /wallpapers/<number>.png or empty
    return /^\/wallpapers\/\d{1,4}\.png$/.test(p) || p === '';
}

/* ── POST /layout — Save widget layout ──────────────────────── */

router.post('/layout', requireAuth, async (req, res) => {
    try {
        const userId = req.session.userId;
        const { widgets, wallpaper } = req.body;

        if (widgets !== undefined && !isValidWidgetArray(widgets)) {
            return res.status(400).json({ success: false, error: 'Invalid widget layout' });
        }

        const payload = JSON.stringify(widgets || []);
        if (payload.length > MAX_LAYOUT_SIZE) {
            return res.status(413).json({ success: false, error: 'Layout too large' });
        }

        await db.setSetting(layoutKey(userId), payload);

        if (wallpaper !== undefined) {
            if (!isValidWallpaperPath(wallpaper)) {
                return res.status(400).json({ success: false, error: 'Invalid wallpaper path' });
            }
            await db.setSetting(wallpaperKey(userId), wallpaper);
        }

        res.json({ success: true });
    } catch (err) {
        console.error('[Desktop] Save layout error:', err.message);
        res.status(500).json({ success: false, error: 'Failed to save layout' });
    }
});

/* ── GET /layout — Load widget layout ───────────────────────── */

router.get('/layout', requireAuth, async (req, res) => {
    try {
        const userId = req.session.userId;
        const layoutRaw = await db.getSetting(layoutKey(userId));
        const wallpaper = await db.getSetting(wallpaperKey(userId));

        let widgets = [];
        if (layoutRaw) {
            try { widgets = JSON.parse(layoutRaw); } catch (_) { /* corrupt — return empty */ }
        }

        res.json({ success: true, data: { widgets, wallpaper: wallpaper || '' } });
    } catch (err) {
        console.error('[Desktop] Load layout error:', err.message);
        res.status(500).json({ success: false, error: 'Failed to load layout' });
    }
});

/* ── GET /wallpapers — List available wallpapers ────────────── */

router.get('/wallpapers', requireAuth, (req, res) => {
    try {
        const dir = path.join(__dirname, '..', 'wallpapers');
        if (!fs.existsSync(dir)) {
            return res.json({ success: true, data: [] });
        }
        const files = fs.readdirSync(dir)
            .filter(f => /^\d+\.png$/i.test(f))
            .sort((a, b) => parseInt(a) - parseInt(b))
            .map(f => '/wallpapers/' + f);

        res.json({ success: true, data: files });
    } catch (err) {
        console.error('[Desktop] List wallpapers error:', err.message);
        res.status(500).json({ success: false, error: 'Failed to list wallpapers' });
    }
});

module.exports = router;
