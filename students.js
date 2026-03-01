const express = require('express');
const db = require('../db');
const { authenticate, requireAdmin } = require('../middleware/auth');
const router = express.Router();
router.use(authenticate);

// GET all students
router.get('/', async (req, res) => {
  try {
    const { program, status, search } = req.query;
    let q = `SELECT s.*, p.label as program_label
             FROM students s
             LEFT JOIN programs p ON p.tenant_id=s.tenant_id AND p.code=s.program_code
             WHERE s.tenant_id=$1`;
    const params = [req.tenantId];
    if (program) { params.push(program); q += ` AND s.program_code=$${params.length}`; }
    if (status)  { params.push(status);  q += ` AND s.status=$${params.length}`; }
    if (search)  { params.push(`%${search}%`); q += ` AND (s.name ILIKE $${params.length} OR s.student_code ILIKE $${params.length} OR s.cnic ILIKE $${params.length})`; }
    q += ' ORDER BY s.student_code';
    const result = await db.query(q, params);
    res.json(result.rows);
  } catch(e){ res.status(500).json({error:e.message}); }
});

// GET single student
router.get('/:id', async (req, res) => {
  const r = await db.query('SELECT * FROM students WHERE id=$1 AND tenant_id=$2', [req.params.id, req.tenantId]);
  if (!r.rows.length) return res.status(404).json({error:'Not found'});
  res.json(r.rows[0]);
});

// POST create student
router.post('/', async (req, res) => {
  const { studentCode, name, fatherName, cnic, mobile, address, programCode, admDate, discPct, discAmt, discNote, photoUrl, extraData } = req.body;
  if (!studentCode || !name) return res.status(400).json({error:'Code and name required'});

  // Check plan student limit
  const planR = await db.query(
    `SELECT p.max_students FROM tenants t JOIN plans p ON p.id=t.plan_id WHERE t.id=$1`, [req.tenantId]
  );
  const maxS = planR.rows[0]?.max_students || 200;
  const countR = await db.query('SELECT COUNT(*) FROM students WHERE tenant_id=$1', [req.tenantId]);
  if (parseInt(countR.rows[0].count) >= maxS) {
    return res.status(403).json({error:`Student limit reached (${maxS}). Please upgrade your plan.`});
  }

  try {
    const r = await db.query(
      `INSERT INTO students (tenant_id,student_code,name,father_name,cnic,mobile,address,program_code,adm_date,disc_pct,disc_amt,disc_note,photo_url,extra_data)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [req.tenantId, studentCode, name, fatherName||'', cnic||'', mobile||'', address||'',
       programCode||'', admDate||null, discPct||0, discAmt||0, discNote||'', photoUrl||'', JSON.stringify(extraData||{})]
    );
    await audit(req, 'Student Added', `${studentCode} — ${name}`);
    res.status(201).json(r.rows[0]);
  } catch(e){
    if (e.code==='23505') return res.status(409).json({error:'Student code already exists'});
    res.status(500).json({error:e.message});
  }
});

// PUT update student
router.put('/:id', async (req, res) => {
  const { name, fatherName, cnic, mobile, address, programCode, admDate, status, discPct, discAmt, discNote, photoUrl, extraData } = req.body;
  try {
    const r = await db.query(
      `UPDATE students SET
        name=COALESCE($1,name), father_name=COALESCE($2,father_name), cnic=COALESCE($3,cnic),
        mobile=COALESCE($4,mobile), address=COALESCE($5,address), program_code=COALESCE($6,program_code),
        adm_date=COALESCE($7,adm_date), status=COALESCE($8,status),
        disc_pct=COALESCE($9,disc_pct), disc_amt=COALESCE($10,disc_amt), disc_note=COALESCE($11,disc_note),
        photo_url=COALESCE($12,photo_url), extra_data=COALESCE($13,extra_data), updated_at=NOW()
       WHERE id=$14 AND tenant_id=$15 RETURNING *`,
      [name, fatherName, cnic, mobile, address, programCode, admDate||null, status,
       discPct, discAmt, discNote, photoUrl, extraData?JSON.stringify(extraData):null,
       req.params.id, req.tenantId]
    );
    if (!r.rows.length) return res.status(404).json({error:'Not found'});
    await audit(req, 'Student Updated', r.rows[0].student_code);
    res.json(r.rows[0]);
  } catch(e){ res.status(500).json({error:e.message}); }
});

// DELETE student (admin only)
router.delete('/:id', requireAdmin, async (req, res) => {
  const r = await db.query('SELECT student_code FROM students WHERE id=$1 AND tenant_id=$2', [req.params.id, req.tenantId]);
  if (!r.rows.length) return res.status(404).json({error:'Not found'});
  await db.query('DELETE FROM students WHERE id=$1 AND tenant_id=$2', [req.params.id, req.tenantId]);
  await audit(req, 'Student Deleted', r.rows[0].student_code);
  res.json({success:true});
});

async function audit(req, action, details) {
  await db.query(
    `INSERT INTO audit_logs(tenant_id,user_name,user_role,action,details) VALUES($1,$2,$3,$4,$5)`,
    [req.tenantId, req.user.username, req.user.role, action, details]
  );
}

module.exports = router;
