process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgres://postgres@localhost:5433/campus_test';
const test = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../src/db');
const { migrate } = require('../scripts/migrate');
const { createApp } = require('../src/app');

let server, base;
class Client {
  constructor() { this.cookie = ''; }
  async call(method, path, body, { csrf = true } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (csrf) headers['X-Requested-With'] = 'CampusLedger';
    if (this.cookie) headers.Cookie = this.cookie;
    const r = await fetch(base + '/api/v1' + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.getSetCookie();
    if (sc.length) this.cookie = sc[0].split(';')[0].endsWith('=') ? '' : sc[0].split(';')[0];
    const json = await r.json().catch(() => ({}));
    return { status: r.status, body: json, data: json.data, error: json.error };
  }
}
const admin = new Client(), s1 = new Client(), s2 = new Client();
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
const ago = n => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);

test.before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(pool);
  server = createApp().listen(0);
  base = 'http://127.0.0.1:' + server.address().port;
});
test.after(async () => { server.close(); await pool.end(); });

test('first-run setup creates one admin, and only one', async () => {
  assert.equal((await admin.call('GET', '/public/info')).data.needsSetup, true);
  const weak = await admin.call('POST', '/setup', { college: 'Test College', name: 'Asha', email: 'asha@test.edu', password: 'short' });
  assert.equal(weak.status, 400);
  const ok = await admin.call('POST', '/setup', { college: 'Test College', name: 'Asha', email: 'ASHA@test.edu', password: 'Admin1234' });
  assert.equal(ok.status, 201);
  assert.equal((await new Client().call('POST', '/setup', { college: 'X College', name: 'Eve', email: 'eve@x.edu', password: 'Hacker123' })).status, 409);
  assert.equal((await admin.call('GET', '/public/info')).data.needsSetup, false);
});

test('requests that change data are rejected without the CSRF header', async () => {
  const r = await new Client().call('POST', '/auth/login', { portal: 'admin', identifier: 'a@b.co', password: 'x' }, { csrf: false });
  assert.equal(r.status, 403); assert.equal(r.error.code, 'CSRF');
});

test('admin login works; wrong password is generic; 5 failures lock the account', async () => {
  const c = new Client();
  const bad = await c.call('POST', '/auth/login', { portal: 'admin', identifier: 'asha@test.edu', password: 'nope' });
  assert.equal(bad.status, 401);
  assert.equal((await c.call('POST', '/auth/login', { portal: 'admin', identifier: 'nobody@test.edu', password: 'nope' })).error.message, bad.error.message);
  for (let i = 0; i < 4; i++) await c.call('POST', '/auth/login', { portal: 'admin', identifier: 'asha@test.edu', password: 'nope' });
  const locked = await c.call('POST', '/auth/login', { portal: 'admin', identifier: 'asha@test.edu', password: 'Admin1234' });
  assert.equal(locked.status, 429);
  await pool.query("UPDATE users SET locked_until = NULL WHERE role = 'ADMIN'");
  assert.equal((await c.call('POST', '/auth/login', { portal: 'admin', identifier: 'asha@test.edu', password: 'Admin1234' })).status, 200);
});

test('anonymous users are blocked; setup session works for admin routes', async () => {
  assert.equal((await new Client().call('GET', '/admin/students')).status, 401);
  assert.equal((await admin.call('GET', '/admin/students')).status, 200);
});

let st1, st2, subj, headT, headL;
test('admin adds subjects, fee heads and students; duplicates are rejected', async () => {
  subj = (await admin.call('POST', '/admin/subjects', { name: 'DBMS' })).data;
  assert.equal((await admin.call('POST', '/admin/subjects', { name: 'dbms' })).status, 409);
  headT = (await admin.call('POST', '/admin/fee-heads', { name: 'Tuition', amountPaise: 1_000_000, dueDate: ago(60) })).data;
  headL = (await admin.call('POST', '/admin/fee-heads', { name: 'Library', amountPaise: 200_000, dueDate: '2099-01-01' })).data;
  const mk = (n, e) => admin.call('POST', '/admin/students', { name: n, enrollmentNo: e, course: 'B.E. CSE', semester: 5, section: 'A', phone: '9876543210', firstPassword: 'first1' });
  st1 = (await mk('Ananya K', 'cs21001')).data; st2 = (await mk('Rohan P', 'CS21002')).data;
  assert.equal(st1.enrollmentNo, 'CS21001');
  assert.equal((await mk('Dup', 'CS21001')).status, 409);
  assert.equal((await admin.call('POST', '/admin/students', { name: 'Bad', enrollmentNo: 'CS21009', course: 'X', semester: 20, firstPassword: 'first1' })).status, 400);
});

test('student must change the first password before anything else', async () => {
  const login = await s1.call('POST', '/auth/login', { portal: 'student', identifier: 'cs21001', password: 'first1' });
  assert.equal(login.status, 200); assert.equal(login.data.mustChangePassword, true);
  assert.equal((await s1.call('GET', '/me/overview')).error.code, 'PASSWORD_CHANGE_REQUIRED');
  assert.equal((await s1.call('POST', '/auth/change-password', { currentPassword: 'first1', newPassword: 'weak' })).status, 400);
  assert.equal((await s1.call('POST', '/auth/change-password', { currentPassword: 'first1', newPassword: 'Student123' })).status, 200);
  assert.equal((await s1.call('GET', '/me/overview')).status, 200);
  await s2.call('POST', '/auth/login', { portal: 'student', identifier: 'CS21002', password: 'first1' });
  await s2.call('POST', '/auth/change-password', { currentPassword: 'first1', newPassword: 'Student456' });
});

test('students cannot use admin endpoints, and the admin portal rejects student logins', async () => {
  for (const [m, p, b] of [['GET', '/admin/students'], ['POST', '/admin/payments', { studentId: st1.id, amountPaise: 100, method: 'Cash' }], ['GET', '/admin/audit'], ['POST', '/admin/attendance', {}]])
    assert.equal((await s1.call(m, p, b)).status, 403, p);
  assert.equal((await new Client().call('POST', '/auth/login', { portal: 'admin', identifier: 'CS21001', password: 'Student123' })).status, 401);
});

test('attendance: corrections update the same row, never duplicate; future dates blocked', async () => {
  const d = ago(1);
  const marks = s => [{ studentId: st1.id, status: s }, { studentId: st2.id, status: 'P' }];
  assert.equal((await admin.call('POST', '/admin/attendance', { subjectId: subj.id, date: d, marks: marks('A') })).data.created, 2);
  const fix = await admin.call('POST', '/admin/attendance', { subjectId: subj.id, date: d, marks: marks('P') });
  assert.deepEqual([fix.data.created, fix.data.corrected], [0, 1]);
  assert.equal((await pool.query('SELECT count(*)::int n FROM attendance_records WHERE student_id=$1', [st1.id])).rows[0].n, 1);
  assert.equal((await admin.call('POST', '/admin/attendance', { subjectId: subj.id, date: '2099-01-01', marks: marks('P') })).status, 400);
  assert.equal((await admin.call('POST', '/admin/attendance', { subjectId: subj.id, date: d, marks: [{ studentId: st1.id, status: 'P' }, { studentId: st1.id, status: 'A' }] })).status, 400);
  await assert.rejects(pool.query("INSERT INTO attendance_records (student_id, subject_id, session_date, status) VALUES ($1,$2,$3,'A')", [st1.id, subj.id, d]), /duplicate key/);
  await admin.call('POST', '/admin/attendance', { subjectId: subj.id, date: ago(2), marks: [{ studentId: st1.id, status: 'A' }, { studentId: st2.id, status: 'E' }] });
  const a = (await s1.call('GET', '/me/attendance')).data.subjects[0];
  assert.deepEqual([a.total, a.attended, a.missed, a.percentage], [2, 1, 1, 50]);
  const b = (await s2.call('GET', '/me/attendance')).data.subjects[0];
  assert.deepEqual([b.total, b.counted, b.percentage], [2, 1, 100]); // excused day not counted
  assert.equal((await s1.call('GET', '/me/attendance')).data.records.every(r => ['P', 'A'].includes(r.status)), true);
});

test('fees: partial payments, no overpayment, balances derived, discounts guarded', async () => {
  let f = (await s1.call('GET', '/me/fees')).data;
  assert.deepEqual([f.totals.net, f.totals.balance], [1_200_000, 1_200_000]);
  assert.equal(f.dues[0].status, 'Overdue');
  const p1 = await admin.call('POST', '/admin/payments', { studentId: st1.id, amountPaise: 400_000, method: 'UPI', reference: 'UPI1' });
  assert.equal(p1.status, 201); assert.equal(p1.data.balanceAfter, 800_000); assert.match(p1.data.receiptNo, /^RCP-\d{5}$/);
  const over = await admin.call('POST', '/admin/payments', { studentId: st1.id, amountPaise: 800_001, method: 'Cash' });
  assert.equal(over.status, 409); assert.equal(over.error.code, 'OVERPAYMENT');
  assert.equal((await admin.call('POST', '/admin/payments', { studentId: st1.id, amountPaise: 0, method: 'Cash' })).status, 400);
  assert.equal((await admin.call('POST', '/admin/payments', { studentId: st1.id, amountPaise: 1.5, method: 'Cash' })).status, 400);
  assert.equal((await admin.call('PUT', `/admin/students/${st1.id}/discounts`, { feeHeadId: headT.id, amountPaise: 2_000_000 })).status, 400);
  assert.equal((await admin.call('PUT', `/admin/students/${st1.id}/discounts`, { feeHeadId: headT.id, amountPaise: 1_000_000 })).status, 409); // owed would drop to 200,000, below the 400,000 already paid
  assert.equal((await admin.call('PUT', `/admin/students/${st2.id}/discounts`, { feeHeadId: headT.id, amountPaise: 100_000, reason: 'Merit' })).status, 200);
  f = (await s1.call('GET', '/me/fees')).data;
  assert.equal(f.totals.balance, 800_000); assert.equal(f.payments.length, 1);
  assert.equal((await s2.call('GET', '/me/fees')).data.totals.net, 1_100_000);
  assert.equal((await admin.call('DELETE', `/admin/fee-heads/${headL.id}`)).error.code, 'HAS_PAYMENTS');
});

test('two simultaneous payments can never overpay', async () => {
  const bal = (await admin.call('GET', '/admin/fees')).data.balances.find(b => b.studentId === st2.id).balance; // 1,100,000
  const amt = Math.round(bal * 0.6);
  const [a, b] = await Promise.all([1, 2].map(() => admin.call('POST', '/admin/payments', { studentId: st2.id, amountPaise: amt, method: 'Cash' })));
  assert.deepEqual([a.status, b.status].sort(), [201, 409]);
  assert.equal((await admin.call('GET', '/admin/fees')).data.balances.find(x => x.studentId === st2.id).balance, bal - amt);
});

test('students see only their own receipts; payments and audit log cannot be altered', async () => {
  const mine = (await s1.call('GET', '/me/fees')).data.payments[0];
  assert.equal((await s1.call('GET', `/payments/${mine.id}`)).data.student.enrollmentNo, 'CS21001');
  assert.equal((await s2.call('GET', `/payments/${mine.id}`)).status, 404);
  assert.equal((await admin.call('GET', `/payments/${mine.id}`)).status, 200);
  await assert.rejects(pool.query('UPDATE payments SET amount_paise = 1'), /append-only/);
  await assert.rejects(pool.query('DELETE FROM payments'), /append-only/);
  await assert.rejects(pool.query("DELETE FROM audit_logs"), /append-only/);
  const log = (await admin.call('GET', '/admin/audit')).data.map(a => a.action);
  for (const x of ['SETUP', 'STUDENT_CREATED', 'ATTENDANCE_MARKED', 'ATTENDANCE_CORRECTED', 'PAYMENT_RECORDED', 'DISCOUNT_SET']) assert.ok(log.includes(x), x);
});

test('announcements: unread counts, marking read', async () => {
  await admin.call('POST', '/admin/announcements', { title: 'Holiday', body: 'Closed Friday.' });
  assert.equal((await s1.call('GET', '/me/announcements')).data.unread, 1);
  await s1.call('POST', '/me/announcements/read');
  assert.equal((await s1.call('GET', '/me/announcements')).data.unread, 0);
  assert.equal((await s2.call('GET', '/auth/me')).data.unread, 1);
});

test('dashboard figures add up', async () => {
  const o = (await admin.call('GET', '/admin/overview')).data;
  assert.equal(o.activeStudents, 2); assert.equal(o.collected, 400_000 + 660_000);
  assert.equal(o.outstanding, 800_000 + 1_100_000 - 660_000);
});

test('deactivating a student signs them out at once; reset forces a new password', async () => {
  assert.equal((await admin.call('POST', `/admin/students/${st1.id}/active`, { active: false })).data.active, false);
  assert.equal((await s1.call('GET', '/me/overview')).status, 401);
  assert.equal((await new Client().call('POST', '/auth/login', { portal: 'student', identifier: 'CS21001', password: 'Student123' })).error.code, 'ACCOUNT_DISABLED');
  await admin.call('POST', `/admin/students/${st1.id}/active`, { active: true });
  await admin.call('POST', `/admin/students/${st1.id}/reset-password`, { password: 'reset99' });
  const c = new Client();
  assert.equal((await c.call('POST', '/auth/login', { portal: 'student', identifier: 'CS21001', password: 'reset99' })).data.mustChangePassword, true);
  assert.equal((await c.call('POST', '/auth/logout')).status, 200);
  assert.equal((await c.call('GET', '/auth/me')).status, 401);
});
