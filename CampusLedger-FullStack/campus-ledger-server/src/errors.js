const { ZodError } = require('zod');

class HttpError extends Error {
  constructor(status, code, message, details) { super(message); this.status = status; this.code = code; this.details = details; }
}
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// One error shape everywhere: { error: { code, message, details? } }
function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);
  if (err instanceof ZodError) {
    const issues = err.issues.map(i => ({ field: i.path.join('.'), message: i.message }));
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: issues[0].message, details: issues } });
  }
  if (err instanceof HttpError) return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: { code: 'BAD_JSON', message: 'Request body is not valid JSON.' } });
  if (err.code === '23505') return res.status(409).json({ error: { code: 'CONFLICT', message: 'That record already exists.' } });
  if (err.code === '23503') return res.status(409).json({ error: { code: 'IN_USE', message: 'That record is in use and cannot be changed.' } });
  console.error('Unhandled error:', err);
  res.status(500).json({ error: { code: 'INTERNAL', message: 'Something went wrong. Please try again.' } });
}
module.exports = { HttpError, wrap, errorHandler };
