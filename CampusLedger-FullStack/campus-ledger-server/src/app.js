const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const config = require('./config');
const { query } = require('./db');
const { errorHandler, HttpError, wrap } = require('./errors');
const { loadSession, csrfGuard } = require('./middleware/auth');

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  if (config.production) app.set('trust proxy', 1); // behind Render's proxy: real client IPs, secure cookies

  const csp = {
    defaultSrc: ["'self'"], scriptSrc: ["'self'"], scriptSrcAttr: ["'unsafe-inline'"], // page uses inline onclick handlers
    styleSrc: ["'self'", "'unsafe-inline'"], imgSrc: ["'self'", 'data:'], connectSrc: ["'self'"],
    objectSrc: ["'none'"], baseUri: ["'self'"], formAction: ["'self'"], frameAncestors: ["'none'"],
    ...(config.production ? { upgradeInsecureRequests: [] } : {}),
  };
  app.use(helmet({ contentSecurityPolicy: { useDefaults: false, directives: csp } }));
  app.use(express.json({ limit: '50kb' }));
  app.use(cookieParser());
  if (config.env !== 'test') app.use((req, res, next) => {
    const t = Date.now();
    res.on('finish', () => req.path.startsWith('/api') && console.log(JSON.stringify({ m: req.method, p: req.path, s: res.statusCode, ms: Date.now() - t })));
    next();
  });

  app.get('/healthz', wrap(async (req, res) => { await query('SELECT 1'); res.json({ ok: true }); }));

  const api = express.Router();
  api.use(rateLimit({ windowMs: 60 * 1000, limit: 300, standardHeaders: true, legacyHeaders: false, skip: () => config.env === 'test',
    message: { error: { code: 'RATE_LIMITED', message: 'Too many requests. Slow down.' } } }));
  api.use(csrfGuard, loadSession);
  api.use(require('./routes/auth'));
  api.use(require('./routes/receipts'));
  api.use('/admin', require('./routes/admin'));
  api.use('/me', require('./routes/me'));
  api.use((req, res, next) => next(new HttpError(404, 'NOT_FOUND', 'No such endpoint.')));
  app.use('/api/v1', api);

  app.use(express.static(path.join(__dirname, '..', 'public'), { setHeaders: res => res.setHeader('Cache-Control', 'no-cache') }));
  app.use(errorHandler);
  return app;
}
module.exports = { createApp };
