const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const { hash, verify } = require('@node-rs/argon2');
const config = require('../config');
const { query, tx } = require('../db');
const { HttpError, wrap } = require('../errors');
const { z, str, password } = require('../validate');
const { COOKIE, sha256, startSession, requireAuth } = require('../middleware/auth');
const { getSettings, audit } = require('../services/data');

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, limit: 50, standardHeaders: true, legacyHeaders: false,
  skip: () => config.env === 'test',
  message: { error: { code: 'RATE_LIMITED', message: 'Too many attempts. Try again in a few minutes.' } },
});

let dummy;
const dummyHash = async () => (dummy ??= await hash('not-a-real-password-1'));

const userView = (u, unread) => ({
  id: u.id, name: u.name, role: u.role, loginId: u.login_id,
  mustChangePassword: u.must_change_password, ...(unread !== undefined ? { unread } : {}),
});

async function unreadCount(userId) {
  const { rows } = await query(`SELECT COUNT(*)::int AS n FROM announcements a
    WHERE NOT EXISTS (SELECT 1 FROM announcement_reads r WHERE r.announcement_id = a.id AND r.user_id = $1)`, [userId]);
  return rows[0].n;
}

router.get('/public/info', wrap(async (req, res) => {
  const s = await getSettings();
  const a = await query("SELECT 1 FROM users WHERE role = 'ADMIN' LIMIT 1");
  res.json({ data: { college: s.college, needsSetup: a.rowCount === 0 } });
}));

const setupSchema = z.object({
  college: str('College name', 2, 120), name: str('Your name', 2, 80),
  email: str('Email', 3, 120).toLowerCase().email('Enter a valid email address.'), password,
});
router.post('/setup', limiter, wrap(async (req, res) => {
  const b = setupSchema.parse(req.body);
  const user = await tx(async c => {
    await c.query('SELECT pg_advisory_xact_lock(7001)');
    if ((await c.query("SELECT 1 FROM users WHERE role = 'ADMIN'")).rowCount) throw new HttpError(409, 'ALREADY_SETUP', 'Setup is already complete.');
    const u = (await c.query("INSERT INTO users (login_id, name, role, password_hash) VALUES ($1,$2,'ADMIN',$3) RETURNING *",
      [b.email, b.name, await hash(b.password)])).rows[0];
    await c.query("INSERT INTO settings (key, value) VALUES ('college', $1)", [JSON.stringify(b.college)]);
    await audit(c.query.bind(c), u.id, 'SETUP', 'user', u.id, { college: b.college });
    return u;
  });
  await startSession(res, user.id, req);
  res.status(201).json({ data: userView(user) });
}));

const loginSchema = z.object({
  portal: z.enum(['admin', 'student'], { errorMap: () => ({ message: 'Choose Admin or Student.' }) }),
  identifier: str('Email or enrollment number', 1, 120), password: z.string({ required_error: 'Password is required.' }).min(1, 'Password is required.').max(128),
});
router.post('/auth/login', limiter, wrap(async (req, res) => {
  const b = loginSchema.parse(req.body);
  const admin = b.portal === 'admin';
  const loginId = admin ? b.identifier.toLowerCase() : b.identifier.toUpperCase();
  const u = (await query('SELECT * FROM users WHERE login_id = $1 AND role = $2', [loginId, admin ? 'ADMIN' : 'STUDENT'])).rows[0];
  if (u && u.locked_until && new Date(u.locked_until) > new Date())
    throw new HttpError(429, 'ACCOUNT_LOCKED', 'Too many failed attempts. Try again in 15 minutes.');
  const ok = u ? await verify(u.password_hash, b.password) : (await verify(await dummyHash(), b.password), false);
  if (!ok) {
    if (u) await query(`UPDATE users SET failed_login_count = CASE WHEN failed_login_count + 1 >= 5 THEN 0 ELSE failed_login_count + 1 END,
        locked_until = CASE WHEN failed_login_count + 1 >= 5 THEN now() + interval '15 minutes' ELSE locked_until END WHERE id = $1`, [u.id]);
    throw new HttpError(401, 'INVALID_CREDENTIALS', admin ? 'Email or password is incorrect.' : 'Enrollment number or password is incorrect.');
  }
  if (!u.is_active) throw new HttpError(403, 'ACCOUNT_DISABLED', 'This account is deactivated. Contact the college office.');
  await query('UPDATE users SET failed_login_count = 0, locked_until = NULL WHERE id = $1', [u.id]);
  await startSession(res, u.id, req);
  res.json({ data: userView(u, admin ? undefined : await unreadCount(u.id)) });
}));

router.post('/auth/logout', wrap(async (req, res) => {
  const t = req.cookies && req.cookies[COOKIE];
  if (t) await query('DELETE FROM sessions WHERE token_hash = $1', [sha256(t)]);
  res.clearCookie(COOKIE, { path: '/' });
  res.json({ data: { ok: true } });
}));

router.get('/auth/me', requireAuth, wrap(async (req, res) => {
  const unread = req.auth.role === 'STUDENT' ? await unreadCount(req.auth.id) : undefined;
  res.json({ data: userView(req.auth, unread) });
}));

const pwSchema = z.object({ currentPassword: z.string({ required_error: 'Enter your current password.' }).min(1, 'Enter your current password.').max(128), newPassword: password });
router.post('/auth/change-password', requireAuth, wrap(async (req, res) => {
  const b = pwSchema.parse(req.body);
  const u = (await query('SELECT * FROM users WHERE id = $1', [req.auth.id])).rows[0];
  if (!(await verify(u.password_hash, b.currentPassword))) throw new HttpError(400, 'WRONG_PASSWORD', 'Current password is incorrect.');
  if (b.newPassword === b.currentPassword) throw new HttpError(400, 'SAME_PASSWORD', 'Choose a password different from the current one.');
  await tx(async c => {
    await c.query('UPDATE users SET password_hash = $1, must_change_password = false, updated_at = now() WHERE id = $2', [await hash(b.newPassword), u.id]);
    await c.query('DELETE FROM sessions WHERE user_id = $1 AND id <> $2', [u.id, req.auth.session_id]);
    await audit(c.query.bind(c), u.id, 'PASSWORD_CHANGED', 'user', u.id);
  });
  res.json({ data: { ok: true } });
}));

module.exports = router;
