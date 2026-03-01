/**
 * BetterDesk Console - Security Middleware
 * Configures Helmet and custom security headers
 */

const helmet = require('helmet');
const config = require('../config/config');

/**
 * Build CSP connect-src based on HTTPS mode
 * When HTTPS is enabled, also allow wss:// for future WebSocket connections
 */
const connectSources = config.httpsEnabled
    ? ["'self'", "wss:"]
    : ["'self'"];

/**
 * Configure Helmet with appropriate CSP for our app
 * Security policies adjust automatically based on HTTPS mode
 */
const helmetMiddleware = helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'"], // unsafe-eval required by protobuf.js codegen
            scriptSrcAttr: ["'unsafe-inline'"], // Allow inline event handlers (onclick etc.)
            styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
            fontSrc: ["'self'", "https://fonts.gstatic.com"],
            imgSrc: ["'self'", "data:", "blob:"],
            mediaSrc: ["'self'", "blob:"], // blob: required by JMuxer MSE video decoding
            connectSrc: connectSources,
            frameSrc: ["'none'"],
            objectSrc: ["'none'"],
            baseUri: ["'self'"],
            formAction: ["'self'"],
            upgradeInsecureRequests: config.httpsEnabled ? [] : null
        }
    },
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: false,
    crossOriginOpenerPolicy: config.httpsEnabled ? { policy: 'same-origin' } : false,
    originAgentCluster: config.httpsEnabled,
    strictTransportSecurity: config.httpsEnabled
        ? { maxAge: 31536000, includeSubDomains: true, preload: false }
        : false
});

/**
 * Custom security headers
 */
function customSecurityHeaders(req, res, next) {
    // Prevent clickjacking
    res.setHeader('X-Frame-Options', 'DENY');
    
    // Prevent MIME type sniffing
    res.setHeader('X-Content-Type-Options', 'nosniff');
    
    // XSS Protection (disabled for modern browsers, can cause issues in legacy)
    res.setHeader('X-XSS-Protection', '0');
    
    // Referrer policy
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    
    // Permissions policy
    res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
    
    next();
}

/**
 * Combined security middleware
 */
function securityMiddleware(req, res, next) {
    helmetMiddleware(req, res, () => {
        customSecurityHeaders(req, res, next);
    });
}

module.exports = securityMiddleware;
