const jwt = require('jsonwebtoken');
const db = require('../db');

// ── Verify JWT token ──────────────────────────────────────────────────────────
const authenticate = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No token provided' });
    }

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Get user + tenant info
    const result = await db.query(
      `SELECT u.id, u.username, u.full_name, u.role, u.tenant_id,
              t.name as tenant_name, t.slug, t.plan_status, t.is_active as tenant_active,
              t.trial_ends_at, t.subscription_ends_at, t.settings as tenant_settings
       FROM users u
       JOIN tenants t ON t.id = u.tenant_id
       WHERE u.id = $1 AND u.is_active = true`,
      [decoded.userId]
    );

    if (!result.rows.length) {
      return res.status(401).json({ error: 'User not found or inactive' });
    }

    const user = result.rows[0];

    // Check tenant subscription
    if (!user.tenant_active) {
      return res.status(403).json({ error: 'Account suspended. Contact support.' });
    }

    const now = new Date();
    if (user.plan_status === 'trial' && user.trial_ends_at && new Date(user.trial_ends_at) < now) {
      return res.status(403).json({
        error: 'Trial expired',
        code: 'TRIAL_EXPIRED',
        message: 'Your free trial has ended. Please subscribe to continue.'
      });
    }

    if (user.plan_status === 'active' && user.subscription_ends_at && new Date(user.subscription_ends_at) < now) {
      return res.status(403).json({
        error: 'Subscription expired',
        code: 'SUB_EXPIRED',
        message: 'Your subscription has expired. Please renew to continue.'
      });
    }

    req.user = user;
    req.tenantId = user.tenant_id;
    next();
  } catch (err) {
    if (err.name === 'JsonWebTokenError') return res.status(401).json({ error: 'Invalid token' });
    if (err.name === 'TokenExpiredError') return res.status(401).json({ error: 'Token expired' });
    console.error('Auth error:', err);
    res.status(500).json({ error: 'Authentication failed' });
  }
};

// ── Require Admin role ────────────────────────────────────────────────────────
const requireAdmin = (req, res, next) => {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
};

// ── Super Admin (platform owner) ─────────────────────────────────────────────
const superAdminAuth = (req, res, next) => {
  const token = req.headers['x-super-admin-key'];
  if (token !== process.env.SUPER_ADMIN_KEY) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
};

// ── Generate JWT ──────────────────────────────────────────────────────────────
const generateToken = (userId) => {
  return jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: '7d' });
};

module.exports = { authenticate, requireAdmin, superAdminAuth, generateToken };
