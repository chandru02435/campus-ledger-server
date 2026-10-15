# Campus Ledger server

Node.js + Express + PostgreSQL. One service provides the REST API (`/api/v1`) and the web app (`public/`),
so browsers and the Android app use the same address.

## Run it on your computer
1. Install Node 20+ and PostgreSQL. Create a database: `createdb campus_ledger`
2. `cp .env.example .env` and set `DATABASE_URL`.
3. `npm install`
4. `npm start` (applies migrations, then serves on http://localhost:3000)
5. Open the address. On the **Admin** tab, create the administrator account (first run only).
   Then add subjects, fee heads and students. Give each student their enrollment number and first password.

## Tests
Create a second database (`createdb campus_test`), then
`TEST_DATABASE_URL=postgres://USER:PASS@localhost:5432/campus_test npm test`.
The suite drops and recreates that database's tables, so never point it at real data.
It covers fee and attendance rules, login lockout, CSRF, role checks, duplicate prevention,
overpayment (including two simultaneous payments), append-only payments and audit log, and deactivation.

## Deploy for free (Neon + Render)
1. **Database:** create a project at neon.tech and copy the connection string (ends with `?sslmode=require`).
2. **Code:** push this folder to a GitHub repo.
3. **Server:** on render.com choose New > Blueprint (uses `render.yaml`), or New > Web Service with build `npm ci`
   and start `npm start`. Add `DATABASE_URL` and `NODE_ENV=production`.
4. Open `https://<your-service>.onrender.com`, create the admin account, then put that address in the
   Android app's `serverUrl`.

Free-tier limits: Render's free service sleeps when idle (the first request after a pause takes about a minute),
and Neon's free plan has little storage and limited backup history. Fine for a demo or pilot; pay for always-on
hosting and daily backups before a real college relies on it.

## What the server enforces
- Passwords: argon2id. Sessions: random token in an httpOnly cookie, only its SHA-256 stored, revocable
  (deactivating or resetting a student signs them out at once). 5 wrong passwords lock the account for 15 minutes.
- Every route checks the role on the server. Student routes use the id from the session, never from the request.
- State-changing requests need an `X-Requested-With: CampusLedger` header (CSRF guard). Input is validated with zod.
- Money is integer paise. Balances and attendance percentages are computed, never stored.
- One attendance row per student, subject and day (database UNIQUE constraint). Corrections update that row and are logged.
- Payments are checked against the outstanding balance inside a transaction that locks the student's row,
  so simultaneous payments cannot overpay. The `payments` and `audit_logs` tables reject UPDATE and DELETE.
- Helmet security headers, a Content-Security-Policy, and rate limits on sign-in and the API.

## API at a glance (all under /api/v1, JSON, responses are `{data}` or `{error:{code,message}}`)
| Area | Endpoints |
|---|---|
| Public / auth | GET `/public/info`, POST `/setup`, POST `/auth/login`, `/auth/logout`, `/auth/change-password`, GET `/auth/me` |
| Admin | `/admin/overview`, `/admin/students` (+ PATCH, `/reset-password`, `/active`, PUT `/discounts`), `/admin/subjects`, `/admin/attendance`, `/admin/fees`, `/admin/fee-heads`, `/admin/payments`, `/admin/announcements`, `/admin/audit`, `/admin/settings` |
| Student | `/me/overview`, `/me/attendance`, `/me/fees`, `/me/announcements` (+ `/read`), `/me/profile` |
| Both | GET `/payments/:id` (receipt; students see only their own) |

## Known limits and next steps
- Schema is simplified to match the app: course, semester and section are text on the student, there is no separate
  department/class/academic-year table, and fee heads apply to every active student. Normalising these is the next migration.
- No refunds, online payments, email/SMS, faculty role or Excel/PDF reports yet. Online payments need gateway credentials
  and signed-webhook handling.
- Lists load up to 500 students and filter in the browser; add server-side paging before using it for thousands.
- The page uses inline click handlers, so the CSP allows `script-src-attr 'unsafe-inline'`. All dynamic text is escaped;
  switching to event listeners would let you remove that allowance.
- Back up your database regularly and test restoring it.
