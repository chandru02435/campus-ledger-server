require('dotenv').config();
const env = process.env;
const production = env.NODE_ENV === 'production';
module.exports = {
  env: env.NODE_ENV || 'development',
  production,
  port: Number(env.PORT) || 3000,
  databaseUrl: env.DATABASE_URL,
  cookieSecure: env.COOKIE_SECURE ? env.COOKIE_SECURE === 'true' : production,
  sessionDays: Number(env.SESSION_DAYS) || 7,
  tz: env.COLLEGE_TZ || 'Asia/Kolkata',
};
