const config = require('./config');
const { pool } = require('./db');
const { createApp } = require('./app');

if (!config.databaseUrl) { console.error('DATABASE_URL is not set. Copy .env.example to .env and fill it in.'); process.exit(1); }
const server = createApp().listen(config.port, () => console.log(`Campus Ledger listening on port ${config.port} (${config.env})`));
const stop = () => server.close(() => pool.end().then(() => process.exit(0)));
process.on('SIGTERM', stop); process.on('SIGINT', stop);
