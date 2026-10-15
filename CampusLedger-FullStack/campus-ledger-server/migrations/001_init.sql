-- Campus Ledger schema v1. Money is BIGINT paise. Dates are DATE (college local time).

CREATE TABLE users (
  id                   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  login_id             TEXT NOT NULL UNIQUE,            -- admin: lower-case email, student: UPPER-CASE enrollment no.
  name                 TEXT NOT NULL,
  role                 TEXT NOT NULL CHECK (role IN ('ADMIN','STUDENT')),
  password_hash        TEXT NOT NULL,
  is_active            BOOLEAN NOT NULL DEFAULT TRUE,
  must_change_password BOOLEAN NOT NULL DEFAULT FALSE,
  failed_login_count   INT NOT NULL DEFAULT 0,
  locked_until         TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,                     -- sha256 of the cookie value, never the value itself
  expires_at  TIMESTAMPTZ NOT NULL,
  user_agent  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_idx ON sessions(user_id);

CREATE TABLE students (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id       BIGINT NOT NULL UNIQUE REFERENCES users(id),
  enrollment_no TEXT NOT NULL UNIQUE CHECK (enrollment_no ~ '^[A-Z0-9]{4,15}$'),
  name          TEXT NOT NULL,
  course        TEXT NOT NULL,
  semester      INT NOT NULL CHECK (semester BETWEEN 1 AND 12),
  section       TEXT NOT NULL DEFAULT '',
  phone         TEXT NOT NULL DEFAULT '',
  address       TEXT NOT NULL DEFAULT '',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE subjects (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX subjects_name_ci ON subjects (lower(name));

-- One row per student, subject and day. The UNIQUE constraint makes duplicates impossible.
CREATE TABLE attendance_records (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  student_id   BIGINT NOT NULL REFERENCES students(id),
  subject_id   BIGINT NOT NULL REFERENCES subjects(id),
  session_date DATE NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('P','A','L','E')),
  marked_by    BIGINT REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (student_id, subject_id, session_date)
);
CREATE INDEX attendance_subject_date_idx ON attendance_records (subject_id, session_date);

CREATE TABLE fee_heads (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name         TEXT NOT NULL,
  amount_paise BIGINT NOT NULL CHECK (amount_paise > 0),
  due_date     DATE NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE student_discounts (
  student_id   BIGINT NOT NULL REFERENCES students(id),
  fee_head_id  BIGINT NOT NULL REFERENCES fee_heads(id) ON DELETE CASCADE,
  amount_paise BIGINT NOT NULL CHECK (amount_paise > 0),
  reason       TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (student_id, fee_head_id)
);

CREATE SEQUENCE receipt_seq;

-- Payments are an append-only ledger. A mistake is corrected by a later adjustment, never an edit.
CREATE TABLE payments (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  student_id   BIGINT NOT NULL REFERENCES students(id),
  amount_paise BIGINT NOT NULL CHECK (amount_paise > 0),
  method       TEXT NOT NULL CHECK (method IN ('Cash','UPI','Bank transfer','Card','Cheque')),
  reference    TEXT NOT NULL DEFAULT '',
  paid_on      DATE NOT NULL,
  receipt_no   TEXT NOT NULL UNIQUE,
  recorded_by  BIGINT REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX payments_student_idx ON payments (student_id);

CREATE TABLE announcements (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL,
  created_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE announcement_reads (
  user_id         BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  announcement_id BIGINT NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, announcement_id)
);

CREATE TABLE audit_logs (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_user_id BIGINT REFERENCES users(id),
  action        TEXT NOT NULL,
  entity        TEXT NOT NULL,
  entity_id     TEXT,
  details       JSONB NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX audit_created_idx ON audit_logs (created_at DESC);

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value JSONB NOT NULL
);

CREATE FUNCTION forbid_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'integrity_constraint_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER payments_append_only BEFORE UPDATE OR DELETE ON payments
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER audit_append_only BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION forbid_change();
