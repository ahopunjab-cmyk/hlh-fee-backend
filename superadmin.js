const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const router = express.Router();

// ── Super Admin Key middleware ─────────────────────────────────────────────────
const superAuth = (req, res, next) => {
  const key = req.headers['x-admin-key'];
  if (!key || key !== process.env.SUPER_ADMIN_KEY) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
};
router.use(superAuth);

// ── GET /superadmin/dashboard — Platform overview ─────────────────────────────
router.get('/dashboard', async (req, res) => {
  const [tenants, revenue, plans, recentSignups] = await Promise.all([
    db.query(`SELECT COUNT(*) as total, plan_status, COUNT(*) FROM tenants GROUP BY plan_status`),
    db.query(`SELECT SUM(amount_pkr) as total_revenue, COUNT(*) as total_payments FROM subscription_payments WHERE status='confirmed'`),
    db.query(`SELECT p.name, COUNT(t.id) as tenants FROM plans p LEFT JOIN tenants t ON t.plan_id=p.id GROUP BY p.name, p.price_pkr ORDER BY p.price_pkr`),
    db.query(`SELECT id, name, email, plan_status, created_at FROM tenants ORDER BY created_at DESC LIMIT 10`),
  ]);
  res.json({
    tenantsByStatus: tenants.rows,
    revenue: revenue.rows[0],
    planBreakdown: plans.rows,
    recentSignups: recentSignups.rows,
  });
});

// ── GET /superadmin/tenants — All institutes ──────────────────────────────────
router.get('/tenants', async (req, res) => {
  const r = await db.query(`
    SELECT t.*, p.name as plan_name, p.price_pkr,
      (SELECT COUNT(*) FROM students s WHERE s.tenant_id=t.id) as student_count,
      (SELECT COUNT(*) FROM users u WHERE u.tenant_id=t.id) as user_count
    FROM tenants t
    LEFT JOIN plans p ON p.id=t.plan_id
    ORDER BY t.created_at DESC
  `);
  res.json(r.rows);
});

// ── GET /superadmin/tenants/:id ───────────────────────────────────────────────
router.get('/tenants/:id', async (req, res) => {
  const [tenant, users, payments, stats] = await Promise.all([
    db.query('SELECT t.*, p.name as plan_name FROM tenants t LEFT JOIN plans p ON p.id=t.plan_id WHERE t.id=$1', [req.params.id]),
    db.query('SELECT id,username,full_name,role,is_active,last_login FROM users WHERE tenant_id=$1', [req.params.id]),
    db.query('SELECT * FROM subscription_payments WHERE tenant_id=$1 ORDER BY created_at DESC', [req.params.id]),
    db.query(`SELECT
      (SELECT COUNT(*) FROM students WHERE tenant_id=$1) as students,
      (SELECT COUNT(*) FROM payments WHERE tenant_id=$1) as payments,
      (SELECT SUM(amount) FROM payments WHERE tenant_id=$1 AND is_deleted=false) as total_collected,
      (SELECT COUNT(*) FROM expenses WHERE tenant_id=$1) as expenses
    `, [req.params.id]),
  ]);
  res.json({ tenant: tenant.rows[0], users: users.rows, payments: payments.rows, stats: stats.rows[0] });
});

// ── PATCH /superadmin/tenants/:id — Update plan/status ───────────────────────
router.patch('/tenants/:id', async (req, res) => {
  const { planId, planStatus, subscriptionEndsAt, isActive, notes } = req.body;
  await db.query(
    `UPDATE tenants SET
       plan_id=COALESCE($1,plan_id),
       plan_status=COALESCE($2,plan_status),
       subscription_ends_at=COALESCE($3,subscription_ends_at),
       is_active=COALESCE($4,is_active),
       updated_at=NOW()
     WHERE id=$5`,
    [planId, planStatus, subscriptionEndsAt||null, isActive, req.params.id]
  );
  res.json({ success: true });
});

// ── GET /superadmin/payments — Pending subscription payments ─────────────────
router.get('/payments', async (req, res) => {
  const { status } = req.query;
  let q = `SELECT sp.*, t.name as tenant_name, t.email, p.name as plan_name
           FROM subscription_payments sp
           JOIN tenants t ON t.id=sp.tenant_id
           LEFT JOIN plans p ON p.id=sp.plan_id`;
  const params = [];
  if (status) { params.push(status); q += ` WHERE sp.status=$1`; }
  q += ' ORDER BY sp.created_at DESC';
  const r = await db.query(q, params);
  res.json(r.rows);
});

// ── POST /superadmin/payments/:id/confirm — Confirm payment & activate plan ──
router.post('/payments/:id/confirm', async (req, res) => {
  const { months } = req.body; // How many months to activate
  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    const payR = await client.query('SELECT * FROM subscription_payments WHERE id=$1', [req.params.id]);
    if (!payR.rows.length) return res.status(404).json({ error: 'Payment not found' });
    const pay = payR.rows[0];
    if (pay.status === 'confirmed') return res.status(409).json({ error: 'Already confirmed' });

    // Calculate subscription period
    const tenantR = await client.query('SELECT * FROM tenants WHERE id=$1', [pay.tenant_id]);
    const tenant = tenantR.rows[0];
    const now = new Date();
    let periodStart = now;

    // If already has active subscription, extend from end
    if (tenant.subscription_ends_at && new Date(tenant.subscription_ends_at) > now) {
      periodStart = new Date(tenant.subscription_ends_at);
    }
    const periodEnd = new Date(periodStart);
    periodEnd.setMonth(periodEnd.getMonth() + (months || 1));

    // Confirm payment
    await client.query(
      `UPDATE subscription_payments SET status='confirmed', confirmed_by='SuperAdmin', confirmed_at=NOW(), period_start=$1, period_end=$2 WHERE id=$3`,
      [periodStart, periodEnd, req.params.id]
    );

    // Activate tenant subscription
    await client.query(
      `UPDATE tenants SET plan_id=$1, plan_status='active', subscription_ends_at=$2, updated_at=NOW() WHERE id=$3`,
      [pay.plan_id, periodEnd, pay.tenant_id]
    );

    // Audit
    await client.query(
      `INSERT INTO audit_logs(tenant_id,user_name,user_role,action,details) VALUES($1,'SuperAdmin','superadmin','Subscription Activated',$2)`,
      [pay.tenant_id, `Plan activated until ${periodEnd.toISOString().slice(0,10)}`]
    );

    await client.query('COMMIT');
    res.json({ success: true, periodEnd });
  } catch(e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

// ── POST /superadmin/payments/:id/reject ─────────────────────────────────────
router.post('/payments/:id/reject', async (req, res) => {
  await db.query(
    `UPDATE subscription_payments SET status='rejected', confirmed_by='SuperAdmin', confirmed_at=NOW() WHERE id=$1`,
    [req.params.id]
  );
  res.json({ success: true });
});

// ── POST /superadmin/tenants/:id/reset-password — Reset admin password ────────
router.post('/tenants/:id/reset-password', async (req, res) => {
  const { newPassword } = req.body;
  if (!newPassword || newPassword.length < 6) return res.status(400).json({ error: 'Min 6 chars' });
  const hash = await bcrypt.hash(newPassword, 12);
  await db.query(
    `UPDATE users SET password_hash=$1 WHERE tenant_id=$2 AND role='admin'`,
    [hash, req.params.id]
  );
  res.json({ success: true });
});

// ── GET /superadmin/plans ─────────────────────────────────────────────────────
router.get('/plans', async (req, res) => {
  const r = await db.query('SELECT * FROM plans ORDER BY price_pkr');
  res.json(r.rows);
});

router.post('/plans', async (req, res) => {
  const { name, pricePkr, maxStudents, maxUsers, features } = req.body;
  const r = await db.query(
    `INSERT INTO plans(name,price_pkr,max_students,max_users,features) VALUES($1,$2,$3,$4,$5) RETURNING *`,
    [name, pricePkr, maxStudents||100, maxUsers||3, JSON.stringify(features||{})]
  );
  res.status(201).json(r.rows[0]);
});

module.exports = router;
