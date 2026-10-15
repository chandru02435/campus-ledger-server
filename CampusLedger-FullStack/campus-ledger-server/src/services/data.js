const config = require('../config');
const { query } = require('../db');
const { computeDues, totals } = require('./calc');

// "Today" in the college's timezone, as YYYY-MM-DD.
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: config.tz }).format(new Date());

async function getSettings(q = query) {
  const rows = (await q('SELECT key, value FROM settings')).rows;
  const m = Object.fromEntries(rows.map(r => [r.key, r.value]));
  return { college: m.college || 'Campus Ledger', minAttendance: m.min_attendance || 75 };
}

async function audit(q, actorId, action, entity, entityId, details = {}) {
  await q('INSERT INTO audit_logs (actor_user_id, action, entity, entity_id, details) VALUES ($1,$2,$3,$4,$5)',
    [actorId, action, entity, entityId == null ? null : String(entityId), JSON.stringify(details)]);
}

// Attendance counts per student and subject. 'E' (excused) is left out of the percentage.
async function attendanceAgg(q = query, studentId = null) {
  const params = studentId ? [studentId] : [];
  const { rows } = await q(`
    SELECT r.student_id, r.subject_id, sub.name AS subject,
           COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE r.status <> 'E')::int AS counted,
           COUNT(*) FILTER (WHERE r.status IN ('P','L'))::int AS attended,
           COUNT(*) FILTER (WHERE r.status = 'A')::int AS missed
      FROM attendance_records r JOIN subjects sub ON sub.id = r.subject_id
      ${studentId ? 'WHERE r.student_id = $1' : ''}
     GROUP BY r.student_id, r.subject_id, sub.name ORDER BY sub.name`, params);
  return rows;
}

// Loads what is needed to work out fee balances for one student, or for everyone.
async function feeContext(q = query, studentId = null) {
  const heads = (await q('SELECT id, name, amount_paise, due_date FROM fee_heads')).rows;
  const where = studentId ? 'WHERE student_id = $1' : '';
  const params = studentId ? [studentId] : [];
  const discounts = new Map();
  for (const r of (await q(`SELECT student_id, fee_head_id, amount_paise FROM student_discounts ${where}`, params)).rows) {
    if (!discounts.has(r.student_id)) discounts.set(r.student_id, new Map());
    discounts.get(r.student_id).set(r.fee_head_id, r.amount_paise);
  }
  const paid = new Map((await q(`SELECT student_id, SUM(amount_paise)::bigint AS paid FROM payments ${where} GROUP BY student_id`, params)).rows.map(r => [r.student_id, r.paid]));
  return { heads, discounts, paid };
}

function duesFor(ctx, studentId) {
  return computeDues(ctx.heads, ctx.discounts.get(studentId) || new Map(), ctx.paid.get(studentId) || 0, today());
}
const feeTotals = (ctx, studentId) => totals(duesFor(ctx, studentId));

module.exports = { today, getSettings, audit, attendanceAgg, feeContext, duesFor, feeTotals };
