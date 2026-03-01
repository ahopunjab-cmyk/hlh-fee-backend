const express = require('express');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const db = require('./index');
const { generateToken, authenticate } = require('./authmw');

const router = express.Router();

// ── POST /api/auth/register — New institute signup ────────────────────────────
router.post('/register', async (req, res) => {
  const { instituteName, email, phone, address, adminUsername, adminPassword } = req.body;

  if (!instituteName || !email || !adminUsername || !adminPassword) {
    return res.status(400).json({ error: 'All fields required' });
  }
  if (adminPassword.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }

  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    // Check email not already used
    const existing = await client.query('SELECT id FROM tenants WHERE email = $1', [email.toLowerCase()]);
    if (existing.rows.length) {
      return res.status(409).json({ error: 'Email already registered' });
    }

    // Create slug from institute name
    let slug = instituteName.toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 50);
    // Make slug unique
    const slugCheck = await client.query('SELECT id FROM tenants WHERE slug = $1', [slug]);
    if (slugCheck.rows.length) slug = slug + '-' + Date.now().toString().slice(-4);

    // Get Trial plan
    const planResult = await client.query("SELECT id FROM plans WHERE name = 'Trial' LIMIT 1");
    const planId = planResult.rows[0]?.id;

    // Trial ends in N days
    const trialDays = parseInt(process.env.TRIAL_DAYS || '14');
    const trialEndsAt = new Date();
    trialEndsAt.setDate(trialEndsAt.getDate() + trialDays);

    // Create tenant
    const tenantResult = await client.query(
      `INSERT INTO tenants (slug, name, email, phone, address, plan_id, plan_status, trial_ends_at)
       VALUES ($1,$2,$3,$4,$5,$6,'trial',$7) RETURNING id`,
      [slug, instituteName, email.toLowerCase(), phone || '', address || '', planId, trialEndsAt]
    );
    const tenantId = tenantResult.rows[0].id;

    // Create admin user
    const passwordHash = await bcrypt.hash(adminPassword, 12);
    const userResult = await client.query(
      `INSERT INTO users (tenant_id, username, email, full_name, password_hash, role)
       VALUES ($1,$2,$3,$4,$5,'admin') RETURNING id`,
      [tenantId, adminUsername.toLowerCase(), email.toLowerCase(), 'Admin', passwordHash]
    );
    const userId = userResult.rows[0].id;

    // Default programs for new tenant
    const defaultPrograms = [
      ['CMW1', 'Community Midwifery (CMW) Part I'],
      ['LHV1', 'Lady Health Visitor (LHV) Part I'],
      ['CNA1', 'Certified Nursing Assistant (CNA) Part I'],
      ['FSCMT1', 'F.Sc Medical Technology Group Part I'],
      ['CMW2', 'Community Midwifery (CMW) Part II'],
      ['LHV2', 'Lady Health Visitor (LHV) Part II'],
      ['CNA2', 'Certified Nursing Assistant (CNA) Part II'],
      ['FSCMT2', 'F.Sc Medical Technology Group Part II'],
    ];
    for (const [code, label] of defaultPrograms) {
      await client.query(
        'INSERT INTO programs (tenant_id, code, label) VALUES ($1,$2,$3)',
        [tenantId, code, label]
      );
    }

    // Audit log
    await client.query(
      `INSERT INTO audit_logs (tenant_id, user_name, user_role, action, details)
       VALUES ($1,$2,'admin','Tenant Registered','New institute registered')`,
      [tenantId, adminUsername]
    );

    await client.query('COMMIT');

    const token = generateToken(userId);
    res.status(201).json({
      success: true,
      token,
      tenant: { id: tenantId, name: instituteName, slug, trialEndsAt },
      user: { id: userId, username: adminUsername, role: 'admin' },
      message: `Welcome! Your ${trialDays}-day free trial has started.`
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Register error:', err);
    res.status(500).json({ error: 'Registration failed. Please try again.' });
  } finally {
    client.release();
  }
});

// ── POST /api/auth/login ──────────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  const { username, password, tenantSlug } = req.body;
  if (!username || !password || !tenantSlug) {
    return res.status(400).json({ error: 'Username, password and institute ID required' });
  }

  try {
    const result = await db.query(
      `SELECT u.id, u.username, u.full_name, u.role, u.password_hash, u.is_active,
              t.id as tenant_id, t.name as tenant_name, t.slug, t.plan_status,
              t.trial_ends_at, t.subscription_ends_at, t.is_active as tenant_active
       FROM users u
       JOIN tenants t ON t.id = u.tenant_id
       WHERE LOWER(u.username) = LOWER($1) AND t.slug = $2`,
      [username, tenantSlug]
    );

    if (!result.rows.length) {
      return res.status(401).json({ error: 'Invalid username, password or institute ID' });
    }

    const user = result.rows[0];

    if (!user.is_active) {
      return res.status(401).json({ error: 'Account disabled. Contact your admin.' });
    }
    if (!user.tenant_active) {
      return res.status(403).json({ error: 'Institute account suspended. Contact support.' });
    }

    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid username, password or institute ID' });
    }

    // Check trial/subscription
    const now = new Date();
    let warningMessage = null;
    if (user.plan_status === 'trial' && user.trial_ends_at) {
      const trialEnd = new Date(user.trial_ends_at);
      if (trialEnd < now) {
        return res.status(403).json({
          error: 'Trial expired',
          code: 'TRIAL_EXPIRED',
          message: 'Your free trial has expired. Please subscribe to continue.'
        });
      }
      const daysLeft = Math.ceil((trialEnd - now) / (1000 * 60 * 60 * 24));
      if (daysLeft <= 3) warningMessage = `Trial expires in ${daysLeft} day(s). Please subscribe.`;
    }
    if (user.plan_status === 'active' && user.subscription_ends_at) {
      const subEnd = new Date(user.subscription_ends_at);
      if (subEnd < now) {
        return res.status(403).json({
          error: 'Subscription expired',
          code: 'SUB_EXPIRED',
          message: 'Your subscription has expired. Please renew.'
        });
      }
      const daysLeft = Math.ceil((subEnd - now) / (1000 * 60 * 60 * 24));
      if (daysLeft <= 7) warningMessage = `Subscription expires in ${daysLeft} day(s). Please renew.`;
    }

    // Update last login
    await db.query('UPDATE users SET last_login = NOW() WHERE id = $1', [user.id]);

    const token = generateToken(user.id);
    res.json({
      success: true,
      token,
      user: {
        id: user.id,
        username: user.username,
        fullName: user.full_name,
        role: user.role,
      },
      tenant: {
        id: user.tenant_id,
        name: user.tenant_name,
        slug: user.slug,
        planStatus: user.plan_status,
        trialEndsAt: user.trial_ends_at,
        subscriptionEndsAt: user.subscription_ends_at,
      },
      warning: warningMessage
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// ── GET /api/auth/me — Current user info ─────────────────────────────────────
router.get('/me', authenticate, async (req, res) => {
  res.json({ user: req.user, tenantId: req.tenantId });
});

// ── POST /api/auth/change-password ───────────────────────────────────────────
router.post('/change-password', authenticate, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword || newPassword.length < 6) {
    return res.status(400).json({ error: 'Current and new password (min 6 chars) required' });
  }

  const result = await db.query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
  const valid = await bcrypt.compare(currentPassword, result.rows[0].password_hash);
  if (!valid) return res.status(401).json({ error: 'Current password incorrect' });

  const newHash = await bcrypt.hash(newPassword, 12);
  await db.query('UPDATE users SET password_hash = $1 WHERE id = $2', [newHash, req.user.id]);

  res.json({ success: true, message: 'Password changed successfully' });
});

module.exports = router;
