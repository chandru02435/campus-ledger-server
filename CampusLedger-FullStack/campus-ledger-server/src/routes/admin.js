const router = require('express').Router();
const { hash } = require('@node-rs/argon2');
const { query, tx } = require('../db');
const { HttpError, wrap } = require('../errors');
const { z, str, id, date, paise, firstPassword, phone } = require('../validate');
const { requireRole, requireReady } = require('../middleware/auth');
const { pct, average } = require('../services/calc');
const { today, getSettings, audit, attendanceAgg, feeContext, duesFor, feeTotals } = require('../services/data');

router.use(requireRole('ADMIN'), requireReady);
const log = (c, req, ...a) => audit(c.query ? c.query.bind(c) : c, req.auth.id, ...a);

const studentView = r => ({ id: r.id, enrollmentNo: r.enrollment_no, name: r.name, course: r.course, semester: r.semester, section: r.section, phone: r.phone, active: r.is_active });
const STUDENT_SQL = `SELECT s.*, u.is_active FROM students s JOIN users u ON u.id = s.user_id`;

/* ---------- dashboard ---------- */
router.get('/overview', wrap(async (req, res) => {
  const set = await getSettings();
  const students = (await query(`${STUDENT_SQL} WHERE u.is_active`)).rows;
  const active = new Set(students.map(s => s.id));
  const byStudent = new Map(), bySubject = new Map();
  for (const r of await attendanceAgg()) {
    if (!active.has(r.student_id)) continue;
    const p = pct(r.attended, r.counted);
    (byStudent.get(r.student_id) || byStudent.set(r.student_id, []).get(r.student_id)).push(p);
    (bySubject.get(r.subject) || bySubject.set(r.subject, []).get(r.subject)).push(p);
  }
  const ctx = await feeContext();
  let outstanding = 0; const needsAttention = [];
  for (const s of students) {
    const bal = feeTotals(ctx, s.id).balance; outstanding += bal;
    const avg = average(byStudent.get(s.id) || []);
    if (avg !== null && avg < set.minAttendance) needsAttention.push({ id: s.id, name: s.name, attendance: avg, balance: bal });
  }
  const collected = (await query('SELECT COALESCE(SUM(amount_paise),0)::bigint AS n FROM payments')).rows[0].n;
  const all = [...byStudent.values()].map(average);
  res.json({ data: {
    minAttendance: set.minAttendance, activeStudents: students.length, averageAttendance: average(all),
    collected, outstanding, needsAttention,
    subjectAverages: [...bySubject].map(([subject, l]) => ({ subject, average: average(l) })),
    recent: (await query('SELECT created_at, details, action FROM audit_logs ORDER BY id DESC LIMIT 5')).rows
      .map(r => ({ at: r.created_at, text: r.details.text || r.action })),
  } });
}));

/* ---------- students ---------- */
router.get('/students', wrap(async (req, res) => {
  const rows = (await query(`${STUDENT_SQL} ORDER BY s.name LIMIT 500`)).rows;
  res.json({ data: rows.map(studentView) });
}));

const createStudent = z.object({
  name: str('Name', 2, 80), enrollmentNo: str('Enrollment number', 4, 15).toUpperCase().regex(/^[A-Z0-9]{4,15}$/, 'Enrollment number must be 4–15 letters or digits.'),
  course: str('Course', 2, 80), semester: z.number({ invalid_type_error: 'Semester must be between 1 and 12.', required_error: 'Semester must be between 1 and 12.' }).int().min(1, 'Semester must be between 1 and 12.').max(12, 'Semester must be between 1 and 12.'),
  section: z.string().trim().max(10, 'Section is too long.').default(''), phone, firstPassword,
});
router.post('/students', wrap(async (req, res) => {
  const b = createStudent.parse(req.body);
  const s = await tx(async c => {
    if ((await c.query('SELECT 1 FROM users WHERE login_id = $1', [b.enrollmentNo])).rowCount)
      throw new HttpError(409, 'DUPLICATE_ENROLLMENT', 'That enrollment number already exists.');
    const u = (await c.query("INSERT INTO users (login_id, name, role, password_hash, must_change_password) VALUES ($1,$2,'STUDENT',$3,true) RETURNING id",
      [b.enrollmentNo, b.name, await hash(b.firstPassword)])).rows[0];
    const st = (await c.query('INSERT INTO students (user_id, enrollment_no, name, course, semester, section, phone) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
      [u.id, b.enrollmentNo, b.name, b.course, b.semester, b.section, b.phone])).rows[0];
    await log(c, req, 'STUDENT_CREATED', 'student', st.id, { text: `Added student ${b.name} (${b.enrollmentNo})` });
    return { ...st, is_active: true };
  });
  res.status(201).json({ data: studentView(s) });
}));

const editStudent = createStudent.omit({ enrollmentNo: true, firstPassword: true });
router.patch('/students/:id', wrap(async (req, res) => {
  const sid = id.parse(req.params.id), b = editStudent.parse(req.body);
  const s = await tx(async c => {
    const r = (await c.query('UPDATE students SET name=$1, course=$2, semester=$3, section=$4, phone=$5, updated_at=now() WHERE id=$6 RETURNING *',
      [b.name, b.course, b.semester, b.section, b.phone, sid])).rows[0];
    if (!r) throw new HttpError(404, 'NOT_FOUND', 'Student not found.');
    await c.query('UPDATE users SET name=$1, updated_at=now() WHERE id=$2', [b.name, r.user_id]);
    await log(c, req, 'STUDENT_UPDATED', 'student', sid, { text: `Updated student ${b.name}` });
    return (await c.query(`${STUDENT_SQL} WHERE s.id = $1`, [sid])).rows[0];
  });
  res.json({ data: studentView(s) });
}));

router.post('/students/:id/reset-password', wrap(async (req, res) => {
  const sid = id.parse(req.params.id), { password } = z.object({ password: firstPassword }).parse(req.body);
  await tx(async c => {
    const s = (await c.query('SELECT user_id, name FROM students WHERE id = $1', [sid])).rows[0];
    if (!s) throw new HttpError(404, 'NOT_FOUND', 'Student not found.');
    await c.query('UPDATE users SET password_hash=$1, must_change_password=true, failed_login_count=0, locked_until=NULL, updated_at=now() WHERE id=$2', [await hash(password), s.user_id]);
    await c.query('DELETE FROM sessions WHERE user_id = $1', [s.user_id]);
    await log(c, req, 'PASSWORD_RESET', 'student', sid, { text: `Reset password for ${s.name}` });
  });
  res.json({ data: { ok: true } });
}));

router.post('/students/:id/active', wrap(async (req, res) => {
  const sid = id.parse(req.params.id), { active } = z.object({ active: z.boolean({ required_error: 'Choose active or inactive.' }) }).parse(req.body);
  const s = await tx(async c => {
    const st = (await c.query('SELECT user_id, name FROM students WHERE id = $1', [sid])).rows[0];
    if (!st) throw new HttpError(404, 'NOT_FOUND', 'Student not found.');
    await c.query('UPDATE users SET is_active=$1, updated_at=now() WHERE id=$2', [active, st.user_id]);
    if (!active) await c.query('DELETE FROM sessions WHERE user_id = $1', [st.user_id]); // signed out immediately
    await log(c, req, active ? 'STUDENT_ACTIVATED' : 'STUDENT_DEACTIVATED', 'student', sid, { text: `${active ? 'Activated' : 'Deactivated'} ${st.name}` });
    return (await c.query(`${STUDENT_SQL} WHERE s.id = $1`, [sid])).rows[0];
  });
  res.json({ data: studentView(s) });
}));

/* ---------- subjects and attendance ---------- */
router.get('/subjects', wrap(async (req, res) => {
  res.json({ data: (await query('SELECT id, name FROM subjects ORDER BY name')).rows });
}));
router.post('/subjects', wrap(async (req, res) => {
  const { name } = z.object({ name: str('Subject name', 2, 80) }).parse(req.body);
  if ((await query('SELECT 1 FROM subjects WHERE lower(name) = lower($1)', [name])).rowCount) throw new HttpError(409, 'DUPLICATE_SUBJECT', 'That subject already exists.');
  const row = await tx(async c => {
    const r = (await c.query('INSERT INTO subjects (name) VALUES ($1) RETURNING id, name', [name])).rows[0];
    await log(c, req, 'SUBJECT_CREATED', 'subject', r.id, { text: `Added subject ${name}` });
    return r;
  });
  res.status(201).json({ data: row });
}));

router.get('/attendance', wrap(async (req, res) => {
  const q = z.object({ subjectId: id, date }).parse(req.query);
  const rows = (await query('SELECT student_id, status FROM attendance_records WHERE subject_id = $1 AND session_date = $2', [q.subjectId, q.date])).rows;
  res.json({ data: rows.map(r => ({ studentId: r.student_id, status: r.status })) });
}));

const markSchema = z.object({
  subjectId: z.number({ required_error: 'Choose a subject.', invalid_type_error: 'Choose a subject.' }).int().positive('Choose a subject.'), date,
  marks: z.array(z.object({ studentId: z.number().int().positive(), status: z.enum(['P', 'A', 'L', 'E'], { errorMap: () => ({ message: 'Status must be P, A, L or E.' }) }) }))
    .min(1, 'Mark at least one student.').max(500, 'Too many students in one save.')
    .refine(m => new Set(m.map(x => x.studentId)).size === m.length, 'Each student can appear only once.'),
});
router.post('/attendance', wrap(async (req, res) => {
  const b = markSchema.parse(req.body);
  if (b.date > today()) throw new HttpError(400, 'FUTURE_DATE', 'Attendance cannot be marked for a future date.');
  const result = await tx(async c => {
    const subj = (await c.query('SELECT name FROM subjects WHERE id = $1', [b.subjectId])).rows[0];
    if (!subj) throw new HttpError(404, 'NOT_FOUND', 'Subject not found.');
    const ids = b.marks.map(m => m.studentId);
    const ok = (await c.query('SELECT s.id FROM students s JOIN users u ON u.id = s.user_id WHERE s.id = ANY($1::bigint[]) AND u.is_active', [ids])).rowCount;
    if (ok !== ids.length) throw new HttpError(400, 'BAD_STUDENTS', 'One or more students are missing or inactive.');
    const before = new Map((await c.query('SELECT student_id, status FROM attendance_records WHERE subject_id=$1 AND session_date=$2 AND student_id = ANY($3::bigint[])',
      [b.subjectId, b.date, ids])).rows.map(r => [r.student_id, r.status]));
    const changes = b.marks.filter(m => before.has(m.studentId) && before.get(m.studentId) !== m.status)
      .map(m => ({ studentId: m.studentId, from: before.get(m.studentId), to: m.status }));
    await c.query(`INSERT INTO attendance_records (student_id, subject_id, session_date, status, marked_by)
        SELECT t.student_id, $2, $3, t.status, $4 FROM unnest($1::bigint[], $5::text[]) AS t(student_id, status)
        ON CONFLICT (student_id, subject_id, session_date) DO UPDATE SET status = EXCLUDED.status, marked_by = EXCLUDED.marked_by, updated_at = now()`,
      [ids, b.subjectId, b.date, req.auth.id, b.marks.map(m => m.status)]);
    const created = ids.length - before.size;
    await log(c, req, changes.length ? 'ATTENDANCE_CORRECTED' : 'ATTENDANCE_MARKED', 'attendance', b.subjectId,
      { text: `${changes.length ? `Corrected ${changes.length} record(s)` : 'Marked attendance'}: ${subj.name}, ${b.date}`, date: b.date, created, changes: changes.slice(0, 50) });
    return { saved: ids.length, created, corrected: changes.length };
  });
  res.json({ data: result });
}));

/* ---------- fees and payments ---------- */
router.get('/fees', wrap(async (req, res) => {
  const ctx = await feeContext();
  const students = (await query(`${STUDENT_SQL} WHERE u.is_active ORDER BY s.name`)).rows;
  res.json({ data: {
    heads: ctx.heads.sort((a, b) => (a.due_date < b.due_date ? -1 : 1)).map(h => ({ id: h.id, name: h.name, amountPaise: h.amount_paise, dueDate: h.due_date })),
    balances: students.map(s => ({ studentId: s.id, name: s.name, enrollmentNo: s.enrollment_no, ...feeTotals(ctx, s.id) })),
    payments: (await query(`SELECT p.id, p.receipt_no, p.paid_on, p.amount_paise, s.name FROM payments p JOIN students s ON s.id = p.student_id ORDER BY p.id DESC LIMIT 10`)).rows
      .map(p => ({ id: p.id, receiptNo: p.receipt_no, date: p.paid_on, amount: p.amount_paise, studentName: p.name })),
  } });
}));

router.post('/fee-heads', wrap(async (req, res) => {
  const b = z.object({ name: str('Fee name', 2, 80), amountPaise: paise, dueDate: date }).parse(req.body);
  const row = await tx(async c => {
    const r = (await c.query('INSERT INTO fee_heads (name, amount_paise, due_date) VALUES ($1,$2,$3) RETURNING id', [b.name, b.amountPaise, b.dueDate])).rows[0];
    await log(c, req, 'FEE_HEAD_CREATED', 'fee_head', r.id, { text: `Added fee head ${b.name}`, amountPaise: b.amountPaise });
    return r;
  });
  res.status(201).json({ data: { id: row.id } });
}));

router.delete('/fee-heads/:id', wrap(async (req, res) => {
  const hid = id.parse(req.params.id);
  await tx(async c => {
    await c.query('LOCK TABLE payments IN SHARE MODE'); // no payment can slip in while we check
    if ((await c.query('SELECT 1 FROM payments LIMIT 1')).rowCount) throw new HttpError(409, 'HAS_PAYMENTS', 'Fee heads cannot be removed after payments are recorded.');
    const h = (await c.query('DELETE FROM fee_heads WHERE id = $1 RETURNING name', [hid])).rows[0];
    if (!h) throw new HttpError(404, 'NOT_FOUND', 'Fee head not found.');
    await log(c, req, 'FEE_HEAD_REMOVED', 'fee_head', hid, { text: `Removed fee head ${h.name}` });
  });
  res.json({ data: { ok: true } });
}));

router.put('/students/:id/discounts', wrap(async (req, res) => {
  const sid = id.parse(req.params.id);
  const b = z.object({ feeHeadId: z.number().int().positive('Choose a fee head.'), amountPaise: z.number({ invalid_type_error: 'Enter 0 or a positive amount.', required_error: 'Enter 0 or a positive amount.' }).int().min(0, 'Enter 0 or a positive amount.'), reason: z.string().trim().max(200).default('') }).parse(req.body);
  await tx(async c => {
    const st = (await c.query('SELECT name FROM students WHERE id = $1 FOR UPDATE', [sid])).rows[0]; // serialises with payments
    if (!st) throw new HttpError(404, 'NOT_FOUND', 'Student not found.');
    const h = (await c.query('SELECT name, amount_paise FROM fee_heads WHERE id = $1', [b.feeHeadId])).rows[0];
    if (!h) throw new HttpError(404, 'NOT_FOUND', 'Fee head not found.');
    if (b.amountPaise > h.amount_paise) throw new HttpError(400, 'DISCOUNT_TOO_LARGE', 'Discount cannot be more than the fee amount.');
    if (b.amountPaise === 0) await c.query('DELETE FROM student_discounts WHERE student_id=$1 AND fee_head_id=$2', [sid, b.feeHeadId]);
    else await c.query(`INSERT INTO student_discounts (student_id, fee_head_id, amount_paise, reason) VALUES ($1,$2,$3,$4)
        ON CONFLICT (student_id, fee_head_id) DO UPDATE SET amount_paise = EXCLUDED.amount_paise, reason = EXCLUDED.reason`, [sid, b.feeHeadId, b.amountPaise, b.reason]);
    const ctx = await feeContext(c.query.bind(c), sid);
    if ((ctx.paid.get(sid) || 0) > feeTotals(ctx, sid).net) throw new HttpError(409, 'DISCOUNT_BELOW_PAID', "That would put the student's payments above what they owe.");
    await log(c, req, 'DISCOUNT_SET', 'student', sid, { text: `Set discount ${b.amountPaise / 100} on ${h.name} for ${st.name}`, feeHeadId: b.feeHeadId, amountPaise: b.amountPaise, reason: b.reason });
  });
  res.json({ data: { ok: true } });
}));

router.post('/payments', wrap(async (req, res) => {
  const b = z.object({ studentId: z.number().int().positive('Choose a student.'), amountPaise: paise,
    method: z.enum(['Cash', 'UPI', 'Bank transfer', 'Card', 'Cheque'], { errorMap: () => ({ message: 'Choose a payment method.' }) }), reference: z.string().trim().max(80).default('') }).parse(req.body);
  const p = await tx(async c => {
    const st = (await c.query('SELECT name FROM students WHERE id = $1 FOR UPDATE', [b.studentId])).rows[0]; // one payment per student at a time
    if (!st) throw new HttpError(404, 'NOT_FOUND', 'Student not found.');
    const balance = feeTotals(await feeContext(c.query.bind(c), b.studentId), b.studentId).balance;
    if (b.amountPaise > balance) throw new HttpError(409, 'OVERPAYMENT', 'Amount is more than the outstanding balance.', { balance });
    const r = (await c.query(`INSERT INTO payments (student_id, amount_paise, method, reference, paid_on, receipt_no, recorded_by)
        VALUES ($1,$2,$3,$4,$5, 'RCP-' || lpad(nextval('receipt_seq')::text, 5, '0'), $6) RETURNING id, receipt_no, paid_on`,
      [b.studentId, b.amountPaise, b.method, b.reference, today(), req.auth.id])).rows[0];
    await log(c, req, 'PAYMENT_RECORDED', 'payment', r.id, { text: `Recorded payment ${r.receipt_no} for ${st.name}`, amountPaise: b.amountPaise, method: b.method });
    return { id: r.id, receiptNo: r.receipt_no, date: r.paid_on, amount: b.amountPaise, balanceAfter: balance - b.amountPaise };
  });
  res.status(201).json({ data: p });
}));

/* ---------- announcements, audit, settings ---------- */
router.get('/announcements', wrap(async (req, res) => {
  const { tz } = require('../config');
  res.json({ data: (await query('SELECT id, title, body, (created_at AT TIME ZONE $1)::date AS date FROM announcements ORDER BY id DESC LIMIT 100', [tz])).rows });
}));
router.post('/announcements', wrap(async (req, res) => {
  const b = z.object({ title: str('Title', 3, 120), body: str('Message', 3, 2000) }).parse(req.body);
  const row = await tx(async c => {
    const r = (await c.query('INSERT INTO announcements (title, body, created_by) VALUES ($1,$2,$3) RETURNING id', [b.title, b.body, req.auth.id])).rows[0];
    await log(c, req, 'ANNOUNCEMENT_POSTED', 'announcement', r.id, { text: `Posted announcement: ${b.title}` });
    return r;
  });
  res.status(201).json({ data: row });
}));
router.delete('/announcements/:id', wrap(async (req, res) => {
  const aid = id.parse(req.params.id);
  await tx(async c => {
    const r = (await c.query('DELETE FROM announcements WHERE id = $1 RETURNING title', [aid])).rows[0];
    if (!r) throw new HttpError(404, 'NOT_FOUND', 'Announcement not found.');
    await log(c, req, 'ANNOUNCEMENT_DELETED', 'announcement', aid, { text: `Deleted announcement: ${r.title}` });
  });
  res.json({ data: { ok: true } });
}));

router.get('/audit', wrap(async (req, res) => {
  const rows = (await query(`SELECT a.id, a.created_at, a.action, a.details, COALESCE(u.name, 'System') AS actor
    FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_user_id ORDER BY a.id DESC LIMIT 200`)).rows;
  res.json({ data: rows.map(r => ({ id: r.id, at: r.created_at, actor: r.actor, action: r.action, text: r.details.text || r.action })) });
}));

router.get('/settings', wrap(async (req, res) => res.json({ data: await getSettings() })));
router.put('/settings', wrap(async (req, res) => {
  const b = z.object({ college: str('College name', 2, 120), minAttendance: z.number({ invalid_type_error: 'Minimum attendance must be 50 to 100.', required_error: 'Minimum attendance must be 50 to 100.' }).int().min(50, 'Minimum attendance must be 50 to 100.').max(100, 'Minimum attendance must be 50 to 100.') }).parse(req.body);
  await tx(async c => {
    await c.query(`INSERT INTO settings (key, value) VALUES ('college',$1),('min_attendance',$2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify(b.college), JSON.stringify(b.minAttendance)]);
    await log(c, req, 'SETTINGS_UPDATED', 'settings', null, { text: 'Updated settings', ...b });
  });
  res.json({ data: b });
}));

module.exports = router;
