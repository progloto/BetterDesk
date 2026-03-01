/**
 * BetterDesk Console - CSRF Protection Middleware
 * Uses csrf-csrf (double-submit cookie pattern) for stateless CSRF protection.
 * 
 * Token flow:
 *   1. Server generates token, sets it as a cookie + passes to EJS views
 *   2. Client JS reads window.BetterDesk.csrfToken and sends it in X-CSRF-Token header
 *   3. Middleware validates header matches cookie on state-changing requests (POST/PUT/DELETE/PATCH)
 */

const { doubleCsrf } = require('csrf-csrf');
const config = require('../config/config');

const {
    generateToken,
    doubleCsrfProtection
} = doubleCsrf({
    getSecret: () => config.sessionSecret,
    cookieName: '__csrf',
    cookieOptions: {
        httpOnly: true,
        sameSite: 'lax',
        secure: config.httpsEnabled,
        path: '/'
    },
    getTokenFromRequest: (req) => {
        // Read token from X-CSRF-Token header (set by public/js/utils.js)
        return req.headers['x-csrf-token'] || req.body?._csrf || '';
    }
});

/**
 * Middleware that generates a CSRF token and makes it available to views.
 * Must be applied AFTER cookie-parser and session middleware.
 *
 * If the existing __csrf cookie is malformed (e.g. leftover from an older
 * session or manual edit), generating/validating the token will throw.
 * We catch that, clear the bad cookie, and retry once so that the user
 * is never locked out on a simple GET page load.
 */
function csrfTokenProvider(req, res, next) {
    try {
        const token = generateToken(req, res);
        res.locals.csrfToken = token;
        return next();
    } catch (_err) {
        // Clear the corrupt cookie and try once more
        res.clearCookie('__csrf', { path: '/' });
        if (req.cookies) delete req.cookies['__csrf'];
        try {
            const token = generateToken(req, res);
            res.locals.csrfToken = token;
        } catch (_e) {
            // Give views a harmless empty token so rendering never breaks
            res.locals.csrfToken = '';
        }
        return next();
    }
}

/**
 * Wrapper around doubleCsrfProtection that tolerates corrupt cookies on
 * safe HTTP methods (GET / HEAD / OPTIONS).  On those methods the library
 * should never block — but a malformed __csrf cookie can still make it
 * throw.  We catch that, wipe the cookie and let the request through.
 */
function safeCsrfProtection(req, res, next) {
    doubleCsrfProtection(req, res, (err) => {
        if (err && ['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
            // Corrupt cookie on a safe method — clear and continue
            res.clearCookie('__csrf', { path: '/' });
            if (req.cookies) delete req.cookies['__csrf'];
            return next();
        }
        // For state-changing methods (POST/PUT/DELETE/PATCH) propagate normally
        return next(err);
    });
}

module.exports = {
    csrfTokenProvider,
    doubleCsrfProtection: safeCsrfProtection
};
