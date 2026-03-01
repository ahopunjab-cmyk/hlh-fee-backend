const express = require('express');
const db = require('./index');
const { authenticate, requireAdmin } = require('./authmw');
const router = express.Router();

// All routes require auth
router.use(authenticate);

// ── GET /api/tenant — Get full tenant data (initial load) ─────────────────────
router.get('/', async (req, res) => {
  try {
    const tid = req.tenantId;

    const [tenant, programs, users, plans] = await Promise.all([
      db.query('SELECT * FROM tenants WHERE id = $1', [tid]),
      db.query('SELECT * FROM programs WHERE tenant_id = $1 ORDER BY sort_order, code', [tid]),
      db.query('SELECT id, username, full_name, role, is_active, last_login FROM users WHERE tenant_id = $1', [tid]),
      db.query('SELECT * FROM plans WHERE is_active = true ORDER BY price_pkr'),
    ]);

    res.json({
      tenant: tenant.rows[0],
      programs: programs.rows,
      users: users.rows,
      plans: plans.rows,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load tenant data' });
  }
});

// ── PUT /api/tenant/settings — Update institute settings ─────────────────────
router.put('/settings', requireAdmin, async (req, res) => {
  const { instituteName, phone, address, bankTitle, bankName, bankAccount, payInstruction, logoDataUrl, qrDataUrl } = req.body;
  try {
    await db.query(
      `UPDATE tenants SET
         name = COALESCE($1, name),
         phone = COALESCE($2, phone),
         address = COALESCE($3, address),
         bank_title = COALESCE($4, bank_title),
         bank_name = COALESCE($5, bank_name),
         bank_account = COALESCE($6, bank_account),
         pay_instruction = COALESCE($7, pay_instruction),
         logo_url = COALESCE($8, logo_url),
         qr_data_url = COALESCE($9, qr_data_url),
         updated_at = NOW()
       WHERE id = $10`,
      [instituteName, phone, address, bankTitle, bankName, bankAccount, payInstruction, logoDataUrl, qrDataUrl, req.tenantId]
    );

    await db.query(
      `INSERT INTO audit_logs (tenant_id, user_name, user_role, action, details) VALUES ($1,$2,$3,$4,$5)`,
      [req.tenantId, req.user.username, req.user.role, 'Settings Updated', 'Institute settings updated']
    );

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update settings' });
  }
});

// ── GET /api/tenant/programs ──────────────────────────────────────────────────
router.get('/programs', async (req, res) => {
  const result = await db.query(
    'SELECT * FROM programs WHERE tenant_id = $1 AND is_active = true ORDER BY sort_order, code',
    [req.tenantId]
  );
  res.json(result.rows);
});

// ── POST /api/tenant/programs ─────────────────────────────────────────────────
router.post('/programs', requireAdmin, async (req, res) => {
  const { code, label } = req.body;
  if (!code || !label) return res.status(400).json({ error: 'Code and label required' });
  try {
    const result = await db.query(
      'INSERT INTO programs (tenant_id, code, label) VALUES ($1,$2,$3) RETURNING *',
      [req.tenantId, code.toUpperCase(), label]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Program code already exists' });
    res.status(500).json({ error: 'Failed to add program' });
  }
});

// ── DELETE /api/tenant/programs/:code ─────────────────────────────────────────
router.delete('/programs/:code', requireAdmin, async (req, res) => {
  await db.query(
    'UPDATE programs SET is_active = false WHERE tenant_id = $1 AND code = $2',
    [req.tenantId, req.params.code]
  );
  res.json({ success: true });
});

// ── GET /api/tenant/users ─────────────────────────────────────────────────────
router.get('/users', requireAdmin, async (req, res) => {
  const result = await db.query(
    'SELECT id, username, full_name, role, is_active, last_login FROM users WHERE tenant_id = $1 ORDER BY role, username',
    [req.tenantId]
  );
  res.json(result.rows);
});

// ── POST /api/tenant/users — Create new staff user ────────────────────────────
router.post('/users', requireAdmin, async (req, res) => {
  const bcrypt = require('bcryptjs');
  const { username, fullName, role, password } = req.body;
  if (!username || !fullName || !role || !password) return res.status(400).json({ error: 'All fields required' });
  if (password.length < 4) return res.status(400).json({ error: 'Password min 4 characters' });

  try {
    // Check plan user limit
    const planResult = await db.query(
      `SELECT p.max_users FROM tenants t JOIN plans p ON p.id = t.plan_id WHERE t.id = $1`,
      [req.tenantId]
    );
    const maxUsers = planResult.rows[0]?.max_users || 3;
    const countResult = await db.query(
      'SELECT COUNT(*) FROM users WHERE tenant_id = $1 AND is_active = true', [req.tenantId]
    );
    if (parseInt(countResult.rows[0].count) >= maxUsers) {
      return res.status(403).json({ error: `User limit reached (${maxUsers}). Upgrade plan.` });
    }

    const hash = await bcrypt.hash(password, 12);
    const result = await db.query(
      `INSERT INTO users (tenant_id, username, full_name, password_hash, role) VALUES ($1,$2,$3,$4,$5) RETURNING id, username, full_name, role`,
      [req.tenantId, username.toLowerCase(), fullName, hash, role]
    );
    await db.query(
      `INSERT INTO audit_logs (tenant_id, user_name, user_role, action, details) VALUES ($1,$2,$3,$4,$5)`,
      [req.tenantId, req.user.username, req.user.role, 'User Created', `${username} (${role})`]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Username already exists' });
    res.status(500).json({ error: 'Failed to create user' });
  }
});

// ── DELETE /api/tenant/users/:id ─────────────────────────────────────────────
router.delete('/users/:id', requireAdmin, async (req, res) => {
  const result = await db.query(
    'SELECT username FROM users WHERE id = $1 AND tenant_id = $2', [req.params.id, req.tenantId]
  );
  if (!result.rows.length) return res.status(404).json({ error: 'User not found' });
  if (result.rows[0].username === req.user.username) {
    return res.status(400).json({ error: 'Cannot delete yourself' });
  }
  await db.query('UPDATE users SET is_active = false WHERE id = $1 AND tenant_id = $2', [req.params.id, req.tenantId]);
  res.json({ success: true });
});

// ── GET /api/tenant/subscription — Subscription info + plans ─────────────────
router.get('/subscription', async (req, res) => {
  const [tenantR, plansR, paymentsR] = await Promise.all([
    db.query('SELECT t.*, p.name as plan_name, p.price_pkr, p.max_students, p.max_users FROM tenants t LEFT JOIN plans p ON p.id = t.plan_id WHERE t.id = $1', [req.tenantId]),
    db.query('SELECT * FROM plans WHERE is_active = true ORDER BY price_pkr'),
    db.query('SELECT * FROM subscription_payments WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 10', [req.tenantId]),
  ]);
  res.json({
    current: tenantR.rows[0],
    plans: plansR.rows,
    history: paymentsR.rows,
  });
});

// ── POST /api/tenant/subscription/request — Submit payment screenshot ────────
router.post('/subscription/request', async (req, res) => {
  const { planId, amountPkr, paymentMethod, txnReference, screenshotUrl, notes } = req.body;
  if (!planId || !amountPkr || !paymentMethod) {
    return res.status(400).json({ error: 'Plan, amount and payment method required' });
  }
  const result = await db.query(
    `INSERT INTO subscription_payments (tenant_id, plan_id, amount_pkr, payment_method, txn_reference, screenshot_url, notes, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'pending') RETURNING id`,
    [req.tenantId, planId, amountPkr, paymentMethod, txnReference || '', screenshotUrl || '', notes || '']
  );
  res.status(201).json({
    success: true,
    paymentId: result.rows[0].id,
    message: 'Payment submitted. Admin will confirm within 24 hours.'
  });
});

module.exports = router;
