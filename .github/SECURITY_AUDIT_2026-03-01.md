# BetterDesk Security Audit Report

**Date:** 2026-03-01  
**Auditor:** GitHub Copilot (Claude Opus 4.5)  
**Scope:** `betterdesk-server/` (Go), `web-nodejs/` (Node.js)

---

## Executive Summary

This audit identified **24 security findings** across the BetterDesk project:
- **Critical:** 2 ✅ FIXED
- **High:** 5 ✅ FIXED
- **Medium:** 10 ✅ 6 FIXED, 4 LOW RISK (accepted)
- **Low:** 7 (tracked for future work)

Many security best practices are already in place (CSRF protection, session fixation prevention, timing-safe auth, rate limiting, SQL parameterization). The findings below represent remaining gaps or areas for improvement.

---

## Remediation Status (2026-03-01)

| ID | Severity | Description | Status |
|----|----------|-------------|--------|
| C-1 | Critical | Command Injection in pingHost() | ✅ Fixed: spawn() with args array + host validation |
| C-2 | Critical | Password Logging in main.go | ✅ Fixed: Write to secure file with 0600 perms |
| H-1 | High | SQL LIKE Injection | ✅ Fixed: escapeLikePattern() + ESCAPE clause |
| H-2 | High | Error Leakage in Go API | ✅ Fixed: writeInternalError() helper |
| H-3 | High | Error Leakage in Token Handlers | ✅ Fixed: Generic error messages + logging |
| H-4 | High | Path Traversal in i18n | ✅ Fixed: isValidLangCode() validation |
| H-5 | High | MD5 for Hash | ✅ Fixed: SHA256 |
| M-1 | Medium | XSS via innerHTML | ✅ Fixed: Utils.escapeHtml() + SVG sanitization |
| M-2 | Medium | parseInt NaN validation | ✅ Fixed: isNaN() checks added |
| M-3 | Medium | Weak Random in generateId | ✅ Fixed: crypto.randomUUID() |
| M-4 | Medium | Cookie httpOnly: false | ✅ Documented: Intentional for client-side i18n |
| M-5 | Medium | Trust Proxy Default | ✅ Fixed: Default changed to false |
| M-6 | Medium | Missing Content-Type Check | ✅ Fixed: requireJsonContentType middleware |

---

## Critical Findings

### C-1: Command Injection in Network Monitor (CRITICAL)

**File:** [web-nodejs/services/networkMonitor.js](../web-nodejs/services/networkMonitor.js#L60-L64)  
**Severity:** Critical  
**Description:** The `pingHost` function passes user-controllable `host` parameter directly to shell command without sanitization.

**Code:**
```javascript
// Line 60-62
const cmd = isWin
    ? `ping -n 1 -w ${timeoutMs} ${host}`
    : `ping -c 1 -W ${timeoutSec} ${host}`;

const start = Date.now();
exec(cmd, { timeout: timeoutMs + 2000 }, (err, stdout) => {
```

**Impact:** An attacker who can control the `host` parameter can execute arbitrary system commands (e.g., `; rm -rf /` or `& calc.exe`).

**Recommended Fix:**
```javascript
// Validate hostname/IP format before use
const validHostRegex = /^[a-zA-Z0-9][a-zA-Z0-9.-]{0,253}[a-zA-Z0-9]$/;
if (!validHostRegex.test(host) && !net.isIP(host)) {
    return resolve({ success: false, rtt_ms: null, error: 'Invalid host format' });
}
// Use spawn() with array arguments instead of exec()
const { spawn } = require('child_process');
const args = isWin ? ['-n', '1', '-w', String(timeoutMs), host] : ['-c', '1', '-W', String(timeoutSec), host];
const proc = spawn('ping', args);
```

---

### C-2: Initial Admin Password Logged to Console (CRITICAL)

**File:** [betterdesk-server/main.go](../betterdesk-server/main.go#L165)  
**Severity:** Critical  
**Description:** When a random admin password is generated, it is printed to logs in plaintext.

**Code:**
```go
// Line 163-165
if cfg.InitAdminPass == "" {
    log.Printf("  Password: %s", adminPass)
} else {
```

**Impact:** The password may be visible in:
- Docker logs (`docker logs`)
- systemd journal (`journalctl`)
- Log files if stdout is redirected
- CI/CD build logs

**Recommended Fix:**
```go
// Write password to a secure file with restricted permissions instead
if cfg.InitAdminPass == "" {
    passFile := filepath.Join(cfg.DataDir, ".init_password")
    os.WriteFile(passFile, []byte(adminPass), 0600)
    log.Printf("  Password written to: %s (delete after reading)", passFile)
    log.Printf("  (password not shown in logs for security)")
} else {
    log.Printf("  Password: *** (user-provided, not logged)")
}
```

---

## High Findings

### H-1: SQL LIKE Pattern Injection in dbAdapter.js (HIGH)

**File:** [web-nodejs/services/dbAdapter.js](../web-nodejs/services/dbAdapter.js#L629)  
**Severity:** High  
**Description:** The `getAllPeers` function in the new dbAdapter does NOT escape `%` and `_` wildcards in the search parameter, unlike `database.js` which does.

**Code:**
```javascript
// Line 629 - dbAdapter.js (NO escape)
if (filters.search) { where += ' AND (id LIKE ? OR note LIKE ? OR "user" LIKE ?)'; const s = `%${filters.search}%`; params.push(s, s, s); }

// Compare with database.js (CORRECT - with escape)
// Line 435 - database.js
const escaped = escapeLikePattern(filters.search);
sql += " AND (id LIKE ? ESCAPE '\\' OR user LIKE ? ESCAPE '\\' OR note LIKE ? ESCAPE '\\')";
```

**Impact:** User can inject `%` or `_` wildcards to match arbitrary patterns (information disclosure through pattern matching).

**Recommended Fix:**
```javascript
if (filters.search) {
    const escaped = filters.search.replace(/[%_\\]/g, '\\$&');
    where += " AND (id LIKE ? ESCAPE '\\' OR note LIKE ? ESCAPE '\\' OR \"user\" LIKE ? ESCAPE '\\')";
    const s = `%${escaped}%`;
    params.push(s, s, s);
}
```

Also apply to lines: 903, 1510, 2096, 2297, 2889.

---

### H-2: Error Message Information Leakage in Go API (HIGH)

**File:** [betterdesk-server/api/server.go](../betterdesk-server/api/server.go#L327)  
**Severity:** High  
**Description:** Internal error messages are exposed to API clients via `err.Error()`.

**Code:**
```go
// Multiple locations including line 327, 359, 380, 403, 423, 494, 519, 559, 721, 738
writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
```

**Impact:** Internal implementation details, database errors, file paths, and system information may leak to attackers.

**Recommended Fix:**
```go
func handleDbError(w http.ResponseWriter, err error, action string) {
    // Log full error internally
    log.Printf("[api] %s error: %v", action, err)
    // Return generic message to client
    writeJSON(w, http.StatusInternalServerError, map[string]string{
        "error": "Internal server error",
    })
}
```

---

### H-3: Error Leakage in token_handlers.go (HIGH)

**File:** [betterdesk-server/api/token_handlers.go](../betterdesk-server/api/token_handlers.go#L87)  
**Severity:** High  
**Description:** Database and system errors are directly exposed via `http.Error(w, err.Error(), ...)`.

**Code:**
```go
// Lines 87, 150, 175, 199, 229, 249, 258, 343, 391, 409, 465
http.Error(w, err.Error(), http.StatusInternalServerError)
```

**Impact:** Same as H-2 - information leakage.

**Recommended Fix:** Same pattern as H-2.

---

### H-4: Path Traversal Risk in i18n Language Upload (HIGH)

**File:** [web-nodejs/routes/i18n.routes.js](../web-nodejs/routes/i18n.routes.js#L134-L145)  
**Severity:** High  
**Description:** Language code derived from uploaded filename or body is used in file path without full validation.

**Code:**
```javascript
// Line 137-146
const meta = translations._meta;
const code = meta?.code || req.body.code || req.file.originalname.replace('.json', '');

if (!code || code.length < 2 || code.length > 5) {
    return res.status(400).json({
        success: false,
        error: 'Invalid language code'
    });
}

const result = manager.saveLanguage(code, translations);
```

**Impact:** An attacker could potentially submit `../../../etc/passwd` as code (though length check provides some protection). The `saveLanguage` function uses `path.join(config.langDir, ${code}.json)` which may still be vulnerable.

**Recommended Fix:**
```javascript
// Strict validation: only allow alphanumeric + dash, 2-5 chars
if (!/^[a-z]{2}(-[A-Z]{2})?$/.test(code)) {
    return res.status(400).json({
        success: false,
        error: 'Invalid language code format (use: xx or xx-XX)'
    });
}
// Also validate in saveLanguage():
const safeName = path.basename(code); // Extra protection
const filePath = path.join(config.langDir, `${safeName}.json`);
```

---

### H-5: MD5 Used for Sysinfo Hash (HIGH)

**File:** [web-nodejs/routes/rustdesk-api.routes.js](../web-nodejs/routes/rustdesk-api.routes.js#L323)  
**Severity:** High  
**Description:** MD5 is used for creating content hashes, which is cryptographically weak.

**Code:**
```javascript
// Line 323
const hash = require('crypto').createHash('md5')
    .update(JSON.stringify(sysinfo.raw_json))
    .digest('hex')
    .substring(0, 16);
```

**Impact:** While used only for cache invalidation (not security), MD5 is deprecated and could lead to collisions. Using a deprecated algorithm in security-critical software sets a bad precedent.

**Recommended Fix:**
```javascript
const hash = require('crypto').createHash('sha256')
    .update(JSON.stringify(sysinfo.raw_json))
    .digest('hex')
    .substring(0, 32);
```

---

## Medium Findings

### M-1: XSS Risk via innerHTML in Frontend JS (MEDIUM)

**File:** [web-nodejs/public/js/users.js](../web-nodejs/public/js/users.js#L65)  
**Severity:** Medium  
**Description:** User data is rendered via template literals and innerHTML without consistent escaping.

**Code:**
```javascript
// Line 65 - users.js
tableBody.innerHTML = users.map(user => `
    <tr data-id="${user.id}">
        <td>${user.username}</td>
        ...
```

**Impact:** If `user.username` contains `<script>`, it could execute in the admin's browser.

**Context:** The app uses `Utils.escapeHtml()` in some places but not consistently.

**Recommended Fix:**
```javascript
tableBody.innerHTML = users.map(user => `
    <tr data-id="${Utils.escapeHtml(user.id)}">
        <td>${Utils.escapeHtml(user.username)}</td>
        ...
```

Also affected files/lines:
- [settings.js](../web-nodejs/public/js/settings.js#L148-L158)

---

### M-2: Missing NaN Validation for parseInt (MEDIUM)

**File:** [web-nodejs/routes/users.routes.js](../web-nodejs/routes/users.routes.js#L132)  
**Severity:** Medium  
**Description:** `parseInt` results are not checked for `NaN`, which can cause unexpected behavior.

**Code:**
```javascript
// Line 132
const userId = parseInt(req.params.id, 10);
```

**Impact:** If `req.params.id` is "abc", `userId` becomes `NaN`, which may bypass ID-based access controls or cause errors.

**Recommended Fix:**
```javascript
const userId = parseInt(req.params.id, 10);
if (isNaN(userId) || userId <= 0) {
    return res.status(400).json({ success: false, error: 'Invalid user ID' });
}
```

Also check: tickets.routes.js, tenants.routes.js, settings.routes.js

---

### M-3: Weak Random in Frontend generateId (MEDIUM)

**File:** [web-nodejs/public/js/utils.js](../web-nodejs/public/js/utils.js#L128)  
**Severity:** Medium  
**Description:** Uses `Math.random()` for ID generation, which is not cryptographically secure.

**Code:**
```javascript
// Line 128
generateId() {
    return 'id-' + Math.random().toString(36).substr(2, 9);
}
```

**Impact:** For DOM element IDs this is acceptable, but if used for security tokens it would be vulnerable.

**Recommended Fix:**
```javascript
generateId() {
    if (window.crypto && window.crypto.randomUUID) {
        return 'id-' + crypto.randomUUID().split('-')[0];
    }
    return 'id-' + Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
}
```

---

### M-4: Cookie httpOnly: false for Language Cookie (MEDIUM)

**File:** [web-nodejs/routes/i18n.routes.js](../web-nodejs/routes/i18n.routes.js#L90)  
**Severity:** Medium  
**Description:** Language preference cookie is set with `httpOnly: false`.

**Code:**
```javascript
// Line 86-92
res.cookie('betterdesk_lang', code, {
    maxAge: 365 * 24 * 60 * 60 * 1000, // 1 year
    httpOnly: false,
    sameSite: 'lax'
});
```

**Impact:** While language preference is not sensitive, this sets a precedent. JavaScript access to this cookie is intentional (for i18n JS), but if misunderstood could lead to similar patterns for sensitive cookies.

**Recommended Fix:** Add comment explaining why httpOnly is false:
```javascript
res.cookie('betterdesk_lang', code, {
    maxAge: 365 * 24 * 60 * 60 * 1000,
    httpOnly: false, // Intentionally accessible to JS for client-side i18n
    sameSite: 'lax',
    secure: config.httpsEnabled // Add secure flag
});
```

---

### M-5: Trust Proxy Default Value (MEDIUM)

**File:** [web-nodejs/server.js](../web-nodejs/server.js#L40-L42)  
**Severity:** Medium  
**Description:** Default trust proxy is `1`, which trusts one level of proxy. If deployed without a proxy, this could allow IP spoofing.

**Code:**
```javascript
// Line 40-42
const trustProxy = process.env.TRUST_PROXY !== undefined ? 
    (isNaN(process.env.TRUST_PROXY) ? process.env.TRUST_PROXY : parseInt(process.env.TRUST_PROXY, 10)) : 1;
app.set('trust proxy', trustProxy);
```

**Impact:** When running directly (no reverse proxy), attackers can spoof `X-Forwarded-For` to bypass rate limiting.

**Recommended Fix:**
```javascript
// Default to false (safest), require explicit configuration
const trustProxy = process.env.TRUST_PROXY !== undefined ? 
    (isNaN(process.env.TRUST_PROXY) ? process.env.TRUST_PROXY : parseInt(process.env.TRUST_PROXY, 10)) 
    : false;  // Changed from 1 to false
```

---

### M-6: Missing Content-Type Validation in Some Routes (MEDIUM)

**File:** [web-nodejs/routes/devices.routes.js](../web-nodejs/routes/devices.routes.js)  
**Severity:** Medium  
**Description:** POST/PATCH routes don't explicitly validate `Content-Type: application/json`.

**Impact:** Could allow CSRF attacks via form submissions (though CSRF tokens provide protection).

**Recommended Fix:** Add middleware:
```javascript
function requireJson(req, res, next) {
    if (req.method !== 'GET' && !req.is('application/json')) {
        return res.status(415).json({ error: 'Content-Type must be application/json' });
    }
    next();
}
```

---

### M-7: No Rate Limit on Some Admin Endpoints (MEDIUM)

**File:** [web-nodejs/routes/users.routes.js](../web-nodejs/routes/users.routes.js)  
**Severity:** Medium  
**Description:** PATCH and DELETE operations on users have no rate limiting beyond the global API limiter.

**Impact:** An attacker with valid admin credentials could rapidly enumerate/modify users.

**Recommended Fix:** Apply specific rate limiter to sensitive admin operations:
```javascript
const adminOpLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 10,
    message: { success: false, error: 'Too many admin operations' }
});

router.patch('/api/users/:id', requireAuth, requireAdmin, adminOpLimiter, async (req, res) => { ...
```

---

### M-8: WebSocket Session Cookie Only Checks Presence (MEDIUM)

**File:** [web-nodejs/services/wsRelay.js](../web-nodejs/services/wsRelay.js#L79-L85)  
**Severity:** Medium  
**Description:** WebSocket upgrade only checks if session cookie exists, not if it's valid.

**Code:**
```javascript
// Line 79-85
if (!cookies['betterdesk.sid']) {
    console.warn(`WS proxy: Rejected upgrade to ${pathname} — no session cookie`);
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
}
```

**Impact:** An attacker with an expired or invalid session cookie could potentially upgrade the WebSocket connection.

**Recommended Fix:**
```javascript
// Parse and validate the session using express-session
const sessionMiddleware = require('../middleware/session');
sessionMiddleware(request, {}, (err) => {
    if (err || !request.session?.userId) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
    }
    // Continue with upgrade
});
```

---

### M-9: Stack Trace Potential in Error Handler (MEDIUM)

**File:** [web-nodejs/server.js](../web-nodejs/server.js#L140)  
**Severity:** Medium  
**Description:** The error handler logs the full error object which may include stack traces.

**Code:**
```javascript
// Line 140
console.error('Server error:', err);
```

**Impact:** Not a direct vulnerability, but if error.stack includes sensitive paths they appear in logs.

**Recommended Fix:** Already handled correctly for client-side, but ensure `err.stack` is never sent to clients.

---

### M-10: PostgreSQL Configuration in Error Messages (MEDIUM)

**File:** [betterdesk-server/db/postgres.go](../betterdesk-server/db/postgres.go#L157)  
**Severity:** Medium  
**Description:** SQL statements are included in error messages.

**Code:**
```go
// Line 157
return fmt.Errorf("db: PostgreSQL migration failed: %w\nStatement: %s", err, stmt)
```

**Impact:** Internal SQL schema visible in error responses if not properly handled by API layer.

**Recommended Fix:** Log statement internally, return generic error:
```go
log.Printf("[db] Migration failed: %v\nStatement: %s", err, stmt)
return fmt.Errorf("db: database migration failed")
```

---

## Low Findings

### L-1: Hardcoded Default Admin Credentials (LOW)

**File:** [web-nodejs/services/authService.js](../web-nodejs/services/authService.js#L76)  
**Severity:** Low  
**Description:** Default admin password is "admin".

**Code:**
```javascript
const defaultPassword = process.env.DEFAULT_ADMIN_PASSWORD || 'admin';
```

**Impact:** Widely known default password could be tried by attackers.

**Status:** Mitigated by console warnings and documented requirement to change.

---

### L-2: Console.log with Password Context (LOW)

**File:** [web-nodejs/routes/users.routes.js](../web-nodejs/routes/users.routes.js#L278)  
**Severity:** Low  
**Description:** Error logged with "Reset password error" context.

**Code:**
```javascript
console.error('Reset password error:', err);
```

**Impact:** Minimal - no password in error, but context reveals operation type.

---

### L-3: Missing CORS Origin Validation for WAN API (LOW)

**File:** [web-nodejs/middleware/wanSecurity.js](../web-nodejs/middleware/wanSecurity.js#L169-L171)  
**Severity:** Low  
**Description:** CORS headers are set but `Access-Control-Allow-Origin` is not explicitly set to reject browser requests.

**Impact:** Desktop RustDesk client doesn't need CORS, but browser-based attacks could be attempted.

**Recommended Fix:** Add explicit rejection:
```javascript
res.setHeader('Access-Control-Allow-Origin', ''); // Explicitly empty = reject
```

---

### L-4: Go Module Version Mismatch Warning (LOW)

**File:** [betterdesk-server/go.mod](../betterdesk-server/go.mod#L3)  
**Severity:** Low  
**Description:** Go version 1.25.0 specified, which is a future version (current stable is 1.22+).

**Code:**
```go
go 1.25.0
```

**Impact:** May cause build issues on older Go versions.

---

### L-5: Integer Overflow in Settings Limit (LOW)

**File:** [web-nodejs/routes/settings.routes.js](../web-nodejs/routes/settings.routes.js#L102)  
**Severity:** Low  
**Description:** No upper bound on limit parameter.

**Code:**
```javascript
const limit = parseInt(req.query.limit, 10) || 100;
```

**Recommended Fix:**
```javascript
const limit = Math.min(1000, Math.max(1, parseInt(req.query.limit, 10) || 100));
```

---

### L-6: Verbose Enrollment Logging (LOW)

**File:** [betterdesk-server/signal/handler.go](../betterdesk-server/signal/handler.go#L1020)  
**Severity:** Low  
**Description:** Enrollment logs include token names which could be sensitive.

**Code:**
```go
log.Printf("[signal] Enrollment: peer %s matched token %s (managed mode)", peerID, token.Name)
```

**Impact:** Token names visible in logs.

---

### L-7: DeviceID Validation Inconsistency (LOW)

**File:** Multiple  
**Severity:** Low  
**Description:** Device ID validation regex differs between Go server (`^[A-Za-z0-9_-]{6,16}$`) and Node.js console (`/^[A-Za-z0-9_-]+$/`).

**Impact:** Could allow IDs accepted by one system but rejected by another.

**Recommended Fix:** Unify regex across both systems.

---

## Positive Security Controls Observed

The following security best practices are already implemented:

1. **CSRF Protection** - Double-submit cookie pattern with csrf-csrf library
2. **Session Fixation Prevention** - `req.session.regenerate()` after login
3. **Timing-Safe Authentication** - Pre-computed DUMMY_HASH for user enumeration prevention
4. **Parameterized SQL Queries** - Using prepared statements throughout
5. **PBKDF2 Password Hashing** - 100,000 iterations with SHA-256 (Go server)
6. **bcrypt Password Hashing** - 12 salt rounds (Node.js console)
7. **Rate Limiting** - express-rate-limit on API and login endpoints
8. **Helmet Security Headers** - CSP, X-Frame-Options, X-Content-Type-Options
9. **Session Security** - httpOnly, secure, sameSite cookie flags
10. **Input Length Limits** - DoS prevention via bcrypt input limits
11. **WAN API Path Whitelist** - Zero attack surface on dedicated port
12. **TOTP 2FA Support** - Optional two-factor authentication
13. **Audit Logging** - Security events logged with user/IP context
14. **SQL LIKE Escape** - `escapeLikePattern()` in database.js (partially)

---

## Recommendations Summary

### Immediate (Critical/High)
1. Fix command injection in networkMonitor.js
2. Remove password logging in Go main.go
3. Add LIKE pattern escaping to dbAdapter.js
4. Replace err.Error() with generic messages in API responses
5. Strengthen i18n language code validation
6. Replace MD5 with SHA-256 for sysinfo hash

### Short-Term (Medium)
1. Add escapeHtml() consistently in frontend JS
2. Validate parseInt results for NaN
3. Change default trust proxy to false
4. Add Content-Type validation middleware
5. Rate limit admin operations
6. Validate WebSocket session properly

### Long-Term (Low)
1. Unify device ID validation regex
2. Add upper bounds to all limit parameters
3. Review logging for sensitive data
4. Document security configuration options

---

*End of Report*
