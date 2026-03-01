const express = require('express');
const db = require('../db');
const { authenticate, requireAdmin } = require('../middleware/auth');
const router = express.Router();
router.use(authenticate);

// ─────────────────────────────────────────────────────────────
// FEE TEMPLATES
// ─────────────────────────────────────────────────────────────
router.get('/templates', async (req, res) => {
  const r = await db.query('SELECT * FROM fee_templates WHERE tenant_id=$1', [req.tenantId]);
  res.json(r.rows);
});

router.post('/templates', requireAdmin, async (req, res) => {
  const { programCode, tuition, admFee, security, examFee, examMonth, dueDay, finePerDay, fineFlat, months } = req.body;
  if (!programCode) return res.status(400).json({error:'Program code required'});
  try {
    const r = await db.query(
      `INSERT INTO fee_templates (tenant_id,program_code,tuition,adm_fee,security,exam_fee,exam_month,due_day,fine_per_day,fine_flat,months)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (tenant_id,program_code) DO UPDATE SET
         tuition=$3,adm_fee=$4,security=$5,exam_fee=$6,exam_month=$7,due_day=$8,fine_per_day=$9,fine_flat=$10,months=$11,updated_at=NOW()
       RETURNING *`,
      [req.tenantId, programCode, tuition||0, admFee||0, security||0, examFee||0,
       examMonth||null, dueDay||15, finePerDay||0, fineFlat||0, months||24]
    );
    res.json(r.rows[0]);
  } catch(e){ res.status(500).json({error:e.message}); }
});

// ─────────────────────────────────────────────────────────────
// FEE SCHEDULES (Challan schedule per student)
// ─────────────────────────────────────────────────────────────
router.get('/schedule/:studentId', async (req, res) => {
  const r = await db.query(
    'SELECT * FROM fee_schedules WHERE student_id=$1 AND tenant_id=$2 ORDER BY month_key',
    [req.params.studentId, req.tenantId]
  );
  res.json(r.rows);
});

router.post('/schedule/:studentId', requireAdmin, async (req, res) => {
  const { schedule } = req.body; // array of month schedule objects
  if (!Array.isArray(schedule)) return res.status(400).json({error:'Schedule array required'});
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    // Delete existing
    await client.query('DELETE FROM fee_schedules WHERE student_id=$1 AND tenant_id=$2', [req.params.studentId, req.tenantId]);
    // Insert new
    for (const row of schedule) {
      await client.query(
        `INSERT INTO fee_schedules (tenant_id,student_id,month_key,challan_no,due_date,charges,discount,fine_applied,fine_amount)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [req.tenantId, req.params.studentId, row.monthKey, row.challanNo||'',
         row.dueDate||null, row.charges||0, row.discount||0, row.fineApplied||false, row.fineAmount||0]
      );
    }
    await client.query('COMMIT');
    res.json({success:true, rows:schedule.length});
  } catch(e){
    await client.query('ROLLBACK');
    res.status(500).json({error:e.message});
  } finally { client.release(); }
});

// Update single schedule row (fine etc)
router.patch('/schedule/:studentId/:monthKey', requireAdmin, async (req, res) => {
  const { fineApplied, fineAmount } = req.body;
  await db.query(
    `UPDATE fee_schedules SET fine_applied=$1, fine_amount=$2
     WHERE student_id=$3 AND month_key=$4 AND tenant_id=$5`,
    [fineApplied, fineAmount||0, req.params.studentId, req.params.monthKey, req.tenantId]
  );
  res.json({success:true});
});

// ─────────────────────────────────────────────────────────────
// PAYMENTS
// ─────────────────────────────────────────────────────────────
router.get('/payments/:studentId', async (req, res) => {
  const r = await db.query(
    'SELECT * FROM payments WHERE student_id=$1 AND tenant_id=$2 AND is_deleted=false ORDER BY date DESC, created_at DESC',
    [req.params.studentId, req.tenantId]
  );
  res.json(r.rows);
});

router.post('/payments/:studentId', async (req, res) => {
  const { monthKey, receiptNo, date, method, txnId, amount, fineApplied, fineAmount, receivedBy, note } = req.body;
  if (!date || !amount || !receivedBy) return res.status(400).json({error:'Date, amount and received_by required'});
  if (amount <= 0) return res.status(400).json({error:'Amount must be positive'});
  try {
    const r = await db.query(
      `INSERT INTO payments (tenant_id,student_id,month_key,receipt_no,date,method,txn_id,amount,fine_applied,fine_amount,received_by,note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [req.tenantId, req.params.studentId, monthKey||null, receiptNo||'',
       date, method||'Cash', txnId||'', amount, fineApplied||false, fineAmount||0, receivedBy, note||'']
    );
    await audit(req, 'Payment Added', `Student:${req.params.studentId} Month:${monthKey} Amount:${amount}`);
    res.status(201).json(r.rows[0]);
  } catch(e){ res.status(500).json({error:e.message}); }
});

router.put('/payments/:studentId/:paymentId', requireAdmin, async (req, res) => {
  const { monthKey, date, method, txnId, amount, fineApplied, fineAmount, receivedBy, note } = req.body;
  try {
    const r = await db.query(
      `UPDATE payments SET month_key=$1,date=$2,method=$3,txn_id=$4,amount=$5,
        fine_applied=$6,fine_amount=$7,received_by=$8,note=$9,updated_at=NOW()
       WHERE id=$10 AND student_id=$11 AND tenant_id=$12 AND is_deleted=false RETURNING *`,
      [monthKey, date, method, txnId||'', amount, fineApplied||false, fineAmount||0,
       receivedBy, note||'', req.params.paymentId, req.params.studentId, req.tenantId]
    );
    if (!r.rows.length) return res.status(404).json({error:'Not found'});
    await audit(req, 'Payment Edited', `ID:${req.params.paymentId} Amount:${amount}`);
    res.json(r.rows[0]);
  } catch(e){ res.status(500).json({error:e.message}); }
});

router.delete('/payments/:studentId/:paymentId', requireAdmin, async (req, res) => {
  const r = await db.query(
    `UPDATE payments SET is_deleted=true, deleted_by=$1, deleted_at=NOW()
     WHERE id=$2 AND student_id=$3 AND tenant_id=$4 RETURNING id`,
    [req.user.username, req.params.paymentId, req.params.studentId, req.tenantId]
  );
  if (!r.rows.length) return res.status(404).json({error:'Not found'});
  await audit(req, 'Payment Deleted', `ID:${req.params.paymentId}`);
  res.json({success:true});
});

// ─────────────────────────────────────────────────────────────
// EXPENSES
// ─────────────────────────────────────────────────────────────
router.get('/expenses', async (req, res) => {
  const { from, to } = req.query;
  let q = 'SELECT * FROM expenses WHERE tenant_id=$1';
  const params = [req.tenantId];
  if (from) { params.push(from); q += ` AND date>=$${params.length}`; }
  if (to)   { params.push(to);   q += ` AND date<=$${params.length}`; }
  q += ' ORDER BY date DESC';
  const r = await db.query(q, params);
  res.json(r.rows);
});

router.post('/expenses', async (req, res) => {
  const { date, category, description, method, amount } = req.body;
  if (!date || !amount) return res.status(400).json({error:'Date and amount required'});
  const r = await db.query(
    `INSERT INTO expenses (tenant_id,date,category,description,method,amount,created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [req.tenantId, date, category||'General', description||'', method||'Cash', amount, req.user.username]
  );
  res.status(201).json(r.rows[0]);
});

router.delete('/expenses/:id', requireAdmin, async (req, res) => {
  await db.query('DELETE FROM expenses WHERE id=$1 AND tenant_id=$2', [req.params.id, req.tenantId]);
  res.json({success:true});
});

// ─────────────────────────────────────────────────────────────
// AUDIT LOG
// ─────────────────────────────────────────────────────────────
router.get('/audit', requireAdmin, async (req, res) => {
  const r = await db.query(
    'SELECT * FROM audit_logs WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 500',
    [req.tenantId]
  );
  res.json(r.rows);
});

// ─────────────────────────────────────────────────────────────
// BACKUP — export all data
// ─────────────────────────────────────────────────────────────
router.get('/backup', requireAdmin, async (req, res) => {
  const tid = req.tenantId;
  const [students, schedules, payments, expenses, programs, templates, audit] = await Promise.all([
    db.query('SELECT * FROM students WHERE tenant_id=$1', [tid]),
    db.query('SELECT * FROM fee_schedules WHERE tenant_id=$1', [tid]),
    db.query('SELECT * FROM payments WHERE tenant_id=$1', [tid]),
    db.query('SELECT * FROM expenses WHERE tenant_id=$1', [tid]),
    db.query('SELECT * FROM programs WHERE tenant_id=$1', [tid]),
    db.query('SELECT * FROM fee_templates WHERE tenant_id=$1', [tid]),
    db.query('SELECT * FROM audit_logs WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 1000', [tid]),
  ]);
  res.json({
    exportedAt: new Date().toISOString(),
    tenantId: tid,
    students: students.rows,
    schedules: schedules.rows,
    payments: payments.rows,
    expenses: expenses.rows,
    programs: programs.rows,
    templates: templates.rows,
    audit: audit.rows,
  });
});

async function audit(req, action, details) {
  await db.query(
    `INSERT INTO audit_logs(tenant_id,user_name,user_role,action,details) VALUES($1,$2,$3,$4,$5)`,
    [req.tenantId, req.user.username, req.user.role, action, details]
  );
}

module.exports = router;
