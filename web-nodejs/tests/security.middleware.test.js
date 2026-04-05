const request = require('supertest');
const { createTestApp } = require('./helpers');

const securityMiddleware = require('../middleware/security');

function getScriptSrcDirective(cspHeader) {
    const match = cspHeader.match(/script-src ([^;]+)/);
    return match ? match[1] : '';
}

describe('Security Middleware', () => {
    function createSecureApp() {
        const app = createTestApp();
        app.use(securityMiddleware);
        return app;
    }

    it('sets nonce-based CSP on standard pages without unsafe inline script execution', async () => {
        const app = createSecureApp();
        app.get('/dashboard', (_req, res) => {
            res.send('<html><body>ok</body></html>');
        });

        const res = await request(app).get('/dashboard');
        const scriptSrc = getScriptSrcDirective(res.headers['content-security-policy']);

        expect(res.status).toBe(200);
        expect(scriptSrc).toMatch(/'self' 'nonce-[^']+'/);
        expect(scriptSrc).not.toContain("'unsafe-inline'");
        expect(scriptSrc).not.toContain("'unsafe-eval'");
    });

    it('allows unsafe-eval only on remote viewer routes while still issuing a nonce', async () => {
        const app = createSecureApp();
        app.get('/remote/device-123', (_req, res) => {
            res.send('<html><body>remote</body></html>');
        });

        const res = await request(app).get('/remote/device-123');
        const scriptSrc = getScriptSrcDirective(res.headers['content-security-policy']);

        expect(res.status).toBe(200);
        expect(scriptSrc).toMatch(/'self' 'nonce-[^']+'/);
        expect(scriptSrc).toContain("'unsafe-eval'");
        expect(scriptSrc).not.toContain("'unsafe-inline'");
    });
});