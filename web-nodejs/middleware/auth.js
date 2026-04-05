/**
 * BetterDesk Console - Auth Middleware
 * Protects routes that require authentication
 */

/**
 * Require authentication middleware
 * Redirects to login page for HTML requests, returns 401 for API requests
 */
function requireAuth(req, res, next) {
    if (!req.session || !req.session.userId) {
        // API request
        if (req.path.startsWith('/api/')) {
            return res.status(401).json({
                success: false,
                error: 'Unauthorized. Please log in.'
            });
        }
        
        // HTML request - redirect to login
        return res.redirect('/login');
    }
    
    // Block pro-only users from web panel (API-only role)
    if (req.session.user && req.session.user.role === 'pro') {
        req.session.destroy();
        if (req.path.startsWith('/api/')) {
            return res.status(403).json({
                success: false,
                error: 'Pro accounts can only access the RustDesk desktop client API'
            });
        }
        return res.redirect('/login');
    }
    
    // Add user info to locals for templates
    res.locals.user = req.session.user;
    
    next();
}

/**
 * Require specific role
 */
function requireRole(role) {
    return function(req, res, next) {
        if (!req.session || !req.session.userId) {
            if (req.path.startsWith('/api/')) {
                return res.status(401).json({ success: false, error: 'Unauthorized' });
            }
            return res.redirect('/login');
        }
        
        if (req.session.user.role !== role && req.session.user.role !== 'admin') {
            if (req.path.startsWith('/api/')) {
                return res.status(403).json({ success: false, error: 'Forbidden' });
            }
            return res.status(403).render('error', { 
                title: 'Forbidden',
                message: 'You do not have permission to access this resource'
            });
        }
        
        res.locals.user = req.session.user;
        next();
    };
}

/**
 * Optional auth - add user to locals if logged in, but don't require it
 */
function optionalAuth(req, res, next) {
    if (req.session && req.session.userId) {
        res.locals.user = req.session.user;
    } else {
        res.locals.user = null;
    }
    next();
}

/**
 * Guest only - redirect to dashboard if already logged in
 */
function guestOnly(req, res, next) {
    if (req.session && req.session.userId) {
        return res.redirect('/');
    }
    next();
}

/**
 * Require admin role
 */
function requireAdmin(req, res, next) {
    if (!req.session || !req.session.userId) {
        if (req.path.startsWith('/api/')) {
            return res.status(401).json({ success: false, error: 'Unauthorized' });
        }
        return res.redirect('/login');
    }
    
    if (req.session.user.role !== 'admin') {
        if (req.path.startsWith('/api/')) {
            return res.status(403).json({ success: false, error: 'Admin access required' });
        }
        return res.status(403).render('errors/403', { 
            title: 'Forbidden',
            message: 'You do not have permission to access this resource'
        });
    }
    
    res.locals.user = req.session.user;
    next();
}

module.exports = {
    requireAuth,
    requireRole,
    requireAdmin,
    optionalAuth,
    guestOnly
};
