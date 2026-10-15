const crypto = require('crypto');
const config = require('../config');
const { query } = require('../db');
const { HttpError } = require('../errors');

const COOKIE = 'cl_sid';
const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');

async function startSession(res, userId, req) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + config.sessionDays * 864e5);
  await query('INSERT INTO sessions (user_id, token_hash, expires_at, user_agent) VALUES ($1,$2,$3,$4)',
    [userId, sha256(token), expires, String(req.get('user-agent') || '').slice(0, 200)]);
  res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: config.cookieSecure, expires, path: '/' });
}

async function loadSession(req, res, next) {
  try {
    const token = req.cookies && req.cookies[COOKIE];
    if (token) {
      const { rows } = await query(`
        SELECT s.id AS session_id, u.id, u.login_id, u.name, u.role, u.must_change_password, st.id AS student_id
          FROM sessions s JOIN users u ON u.id = s.user_id LEFT JOIN students st ON st.user_id = u.id
         WHERE s.token_hash = $1 AND s.expires_at > now() AND u.is_active`, [sha256(token)]);
      if (rows[0]) req.auth = rows[0];
    }
    next();
  } catch (e) { next(e); }
}

const requireAuth = (req, res, next) =>
  req.auth ? next() : next(new HttpError(401, 'UNAUTHENTICATED', 'Please sign in.'));

const requireRole = role => (req, res, next) => {
  if (!req.auth) return next(new HttpError(401, 'UNAUTHENTICATED', 'Please sign in.'));
  if (req.auth.role !== role) return next(new HttpError(403, 'FORBIDDEN', 'You do not have access to this.'));
  next();
};

// A student with a first-time password must choose their own before using anything else.
const requireReady = (req, res, next) =>
  req.auth && req.auth.must_change_password
    ? next(new HttpError(403, 'PASSWORD_CHANGE_REQUIRED', 'Choose a new password to continue.'))
    : next();

// Blocks cross-site form posts: browsers cannot add this header to a cross-origin request without CORS approval.
function csrfGuard(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.get('x-requested-with') !== 'CampusLedger') return next(new HttpError(403, 'CSRF', 'Request blocked.'));
  next();
}

module.exports = { COOKIE, sha256, startSession, loadSession, requireAuth, requireRole, requireReady, csrfGuard };
