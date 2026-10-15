const { Pool, types } = require('pg');
const config = require('./config');

types.setTypeParser(20, v => parseInt(v, 10)); // BIGINT (paise, counts) -> number
types.setTypeParser(1082, v => v);             // DATE -> 'YYYY-MM-DD' string, no timezone surprises

const pool = new Pool({ connectionString: config.databaseUrl, max: 10 });
const query = (text, params) => pool.query(text, params);

async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
    throw e;
  } finally { client.release(); }
}
module.exports = { pool, query, tx };
