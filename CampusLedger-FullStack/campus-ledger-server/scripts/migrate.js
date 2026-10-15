// Applies any new migrations/*.sql files, in order, each in its own transaction.
const fs = require('fs');
const path = require('path');

async function migrate(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  const dir = path.join(__dirname, '..', 'migrations');
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
  const done = new Set((await pool.query('SELECT name FROM schema_migrations')).rows.map(r => r.name));
  for (const f of files) {
    if (done.has(f)) continue;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(fs.readFileSync(path.join(dir, f), 'utf8'));
      await client.query('INSERT INTO schema_migrations(name) VALUES ($1)', [f]);
      await client.query('COMMIT');
      console.log('Applied migration', f);
    } catch (e) {
      await client.query('ROLLBACK');
      throw new Error(`Migration ${f} failed: ${e.message}`);
    } finally { client.release(); }
  }
}
module.exports = { migrate };

if (require.main === module) {
  const { pool } = require('../src/db');
  migrate(pool).then(() => pool.end()).catch(e => { console.error(e.message); process.exit(1); });
}
