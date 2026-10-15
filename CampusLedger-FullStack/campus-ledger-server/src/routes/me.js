const router = require('express').Router();
const { query, tx } = require('../db');
const { HttpError, wrap } = require('../errors');
const { z, str, phone } = require('../validate');
const config = require('../config');
const { requireRole, requireReady } = require('../middleware/auth');
const { pct, average } = require('../services/calc');
const { getSettings, attendanceAgg, feeContext, duesFor } = require('../services/data');
const { totals } = require('../services/calc');

// Every route here works only on the signed-in student's own records: the id comes from the session, never the request.
router.use(requireRole('STUDENT'), requireReady);

const profileOf = async sid => (await query('SELECT * FROM students WHERE id = $1', [sid])).rows[0];
const profileView = s => ({ name: s.name, enrollmentNo: s.enrollment_no, course: s.course, semester: s.semester, section: s.section, phone: s.phone, address: s.address });
const subjectRows = rows => rows.map(r => ({ id: r.subject_id, subject: r.subject, total: r.total, counted: r.counted, attended: r.attended, missed: r.missed, percentage: pct(r.attended, r.counted) }));
async function announcements(uid) {
  const { rows } = await query(`SELECT a.id, a.title, a.body, (a.created_at AT TIME ZONE $2)::date AS date, (r.user_id IS NOT NULL) AS read
      FROM announcements a LEFT JOIN announcement_reads r ON r.announcement_id = a.id AND r.user_id = $1 ORDER BY a.id DESC LIMIT 100`, [uid, config.tz]);
  return rows;
}

router.get('/overview', wrap(async (req, res) => {
  const sid = req.auth.student_id, set = await getSettings();
  const subjects = subjectRows(await attendanceAgg(query, sid));
  const dues = duesFor(await feeContext(query, sid), sid), t = totals(dues);
  const next = dues.find(d => d.balance > 0);
  const ann = await announcements(req.auth.id);
  res.json({ data: {
    profile: profileView(await profileOf(sid)), minAttendance: set.minAttendance,
    attendance: { average: average(subjects.map(s => s.percentage)), belowSubjects: subjects.filter(s => s.percentage < set.minAttendance).map(s => s.subject) },
    fees: { net: t.net, paid: t.paid, balance: t.balance, next: next ? { head: next.head, dueDate: next.dueDate, balance: next.balance, status: next.status } : null },
    announcements: { latest: ann.slice(0, 2), unread: ann.filter(a => !a.read).length },
  } });
}));

router.get('/attendance', wrap(async (req, res) => {
  const sid = req.auth.student_id, set = await getSettings();
  const records = (await query(`SELECT r.session_date AS date, sub.name AS subject, r.status FROM attendance_records r
      JOIN subjects sub ON sub.id = r.subject_id WHERE r.student_id = $1 ORDER BY r.session_date DESC, sub.name LIMIT 1000`, [sid])).rows;
  res.json({ data: { minAttendance: set.minAttendance, subjects: subjectRows(await attendanceAgg(query, sid)), records } });
}));

router.get('/fees', wrap(async (req, res) => {
  const sid = req.auth.student_id;
  const dues = duesFor(await feeContext(query, sid), sid);
  const payments = (await query('SELECT id, receipt_no, paid_on, amount_paise, method, reference FROM payments WHERE student_id = $1 ORDER BY id DESC', [sid])).rows
    .map(p => ({ id: p.id, receiptNo: p.receipt_no, date: p.paid_on, amount: p.amount_paise, method: p.method, reference: p.reference }));
  res.json({ data: { dues, totals: totals(dues), payments } });
}));

router.get('/announcements', wrap(async (req, res) => {
  const list = await announcements(req.auth.id);
  res.json({ data: { items: list, unread: list.filter(a => !a.read).length } });
}));
router.post('/announcements/read', wrap(async (req, res) => {
  await query(`INSERT INTO announcement_reads (user_id, announcement_id) SELECT $1, id FROM announcements ON CONFLICT DO NOTHING`, [req.auth.id]);
  res.json({ data: { ok: true } });
}));

router.get('/profile', wrap(async (req, res) => res.json({ data: profileView(await profileOf(req.auth.student_id)) })));
router.patch('/profile', wrap(async (req, res) => {
  const b = z.object({ phone, address: z.string().trim().max(200, 'Address is too long.').default('') }).parse(req.body);
  await query('UPDATE students SET phone = $1, address = $2, updated_at = now() WHERE id = $3', [b.phone, b.address, req.auth.student_id]);
  res.json({ data: profileView(await profileOf(req.auth.student_id)) });
}));

module.exports = router;
