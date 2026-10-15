const router = require('express').Router();
const { query } = require('../db');
const { HttpError, wrap } = require('../errors');
const { id } = require('../validate');
const { requireAuth, requireReady } = require('../middleware/auth');
const { getSettings } = require('../services/data');

// Admins can open any receipt. A student can open only their own; anything else looks like "not found".
router.get('/payments/:id', requireAuth, requireReady, wrap(async (req, res) => {
  const pid = id.parse(req.params.id);
  const p = (await query(`SELECT p.id, p.receipt_no, p.paid_on, p.amount_paise, p.method, p.reference, s.id AS student_id, s.name, s.enrollment_no, s.course
      FROM payments p JOIN students s ON s.id = p.student_id WHERE p.id = $1`, [pid])).rows[0];
  if (!p || (req.auth.role === 'STUDENT' && p.student_id !== req.auth.student_id)) throw new HttpError(404, 'NOT_FOUND', 'Receipt not found.');
  res.json({ data: { id: p.id, receiptNo: p.receipt_no, date: p.paid_on, amount: p.amount_paise, method: p.method, reference: p.reference,
    college: (await getSettings()).college, student: { name: p.name, enrollmentNo: p.enrollment_no, course: p.course } } });
}));
module.exports = router;
