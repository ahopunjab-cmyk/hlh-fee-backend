-- ═══════════════════════════════════════════════════════════════
-- HLH Fee Management SaaS — Database Schema
-- Run this in Supabase SQL Editor (or any PostgreSQL)
-- ═══════════════════════════════════════════════════════════════

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ─────────────────────────────────────────────────────────────
-- 1. SUBSCRIPTION PLANS
-- ─────────────────────────────────────────────────────────────
CREATE TABLE plans (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name        VARCHAR(100) NOT NULL,          -- Basic, Pro, Enterprise
  price_pkr   INTEGER NOT NULL,               -- Monthly price in PKR
  max_students INTEGER NOT NULL DEFAULT 100,
  max_users   INTEGER NOT NULL DEFAULT 3,
  features    JSONB DEFAULT '{}',
  is_active   BOOLEAN DEFAULT true,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Default plans
INSERT INTO plans (name, price_pkr, max_students, max_users, features) VALUES
  ('Trial',      0,    50,   2, '{"reports":true,"backup":true,"whatsapp":false}'),
  ('Basic',   2000,   200,   3, '{"reports":true,"backup":true,"whatsapp":false}'),
  ('Pro',     4500,   500,   8, '{"reports":true,"backup":true,"whatsapp":true}'),
  ('Enterprise', 8000, 9999, 20, '{"reports":true,"backup":true,"whatsapp":true,"api":true}');

-- ─────────────────────────────────────────────────────────────
-- 2. TENANTS (Schools/Institutes)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE tenants (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  slug            VARCHAR(60) UNIQUE NOT NULL,   -- e.g. "health-learner-hub"
  name            VARCHAR(200) NOT NULL,
  email           VARCHAR(200) UNIQUE NOT NULL,
  phone           VARCHAR(50),
  address         TEXT,
  logo_url        TEXT,
  plan_id         UUID REFERENCES plans(id),
  plan_status     VARCHAR(20) DEFAULT 'trial',   -- trial | active | suspended | cancelled
  trial_ends_at   TIMESTAMPTZ,
  subscription_ends_at TIMESTAMPTZ,
  bank_title      VARCHAR(200),
  bank_name       VARCHAR(200),
  bank_account    VARCHAR(100),
  pay_instruction TEXT,
  qr_data_url     TEXT,
  settings        JSONB DEFAULT '{}',
  is_active       BOOLEAN DEFAULT true,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────────────────────────
-- 3. USERS (Staff per tenant)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  username      VARCHAR(60) NOT NULL,
  email         VARCHAR(200),
  full_name     VARCHAR(200),
  password_hash VARCHAR(200) NOT NULL,
  role          VARCHAR(20) NOT NULL DEFAULT 'cashier',  -- admin | cashier | operator
  is_active     BOOLEAN DEFAULT true,
  last_login    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(tenant_id, username)
);

-- ─────────────────────────────────────────────────────────────
-- 4. PROGRAMS (Per tenant)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE programs (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code        VARCHAR(30) NOT NULL,
  label       VARCHAR(200) NOT NULL,
  sort_order  INTEGER DEFAULT 0,
  is_active   BOOLEAN DEFAULT true,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(tenant_id, code)
);

-- ─────────────────────────────────────────────────────────────
-- 5. FEE TEMPLATES (Per tenant per program)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE fee_templates (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  program_code VARCHAR(30) NOT NULL,
  tuition     INTEGER DEFAULT 0,
  adm_fee     INTEGER DEFAULT 0,
  security    INTEGER DEFAULT 0,
  exam_fee    INTEGER DEFAULT 0,
  exam_month  VARCHAR(7),   -- YYYY-MM
  due_day     INTEGER DEFAULT 15,
  fine_per_day INTEGER DEFAULT 0,
  fine_flat   INTEGER DEFAULT 0,
  months      INTEGER DEFAULT 24,
  data        JSONB DEFAULT '{}',
  updated_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(tenant_id, program_code)
);

-- ─────────────────────────────────────────────────────────────
-- 6. STUDENTS
-- ─────────────────────────────────────────────────────────────
CREATE TABLE students (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  student_code  VARCHAR(30) NOT NULL,           -- e.g. CMW1-001
  name          VARCHAR(200) NOT NULL,
  father_name   VARCHAR(200),
  cnic          VARCHAR(20),
  mobile        VARCHAR(30),
  address       TEXT,
  program_code  VARCHAR(30),
  adm_date      DATE,
  status        VARCHAR(20) DEFAULT 'Active',   -- Active | Left | Freeze
  disc_pct      NUMERIC(5,2) DEFAULT 0,
  disc_amt      INTEGER DEFAULT 0,
  disc_note     TEXT,
  photo_url     TEXT,
  extra_data    JSONB DEFAULT '{}',
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(tenant_id, student_code)
);

-- ─────────────────────────────────────────────────────────────
-- 7. FEE SCHEDULES (Challan schedule per student)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE fee_schedules (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  student_id    UUID NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  month_key     VARCHAR(7) NOT NULL,            -- YYYY-MM
  challan_no    VARCHAR(50),
  due_date      DATE,
  charges       INTEGER DEFAULT 0,
  discount      INTEGER DEFAULT 0,
  fine_applied  BOOLEAN DEFAULT false,
  fine_amount   INTEGER DEFAULT 0,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(tenant_id, student_id, month_key)
);

-- ─────────────────────────────────────────────────────────────
-- 8. PAYMENTS
-- ─────────────────────────────────────────────────────────────
CREATE TABLE payments (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  student_id    UUID NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  month_key     VARCHAR(7),
  receipt_no    VARCHAR(50),
  date          DATE NOT NULL,
  method        VARCHAR(50) DEFAULT 'Cash',
  txn_id        VARCHAR(200),
  amount        INTEGER NOT NULL,
  fine_applied  BOOLEAN DEFAULT false,
  fine_amount   INTEGER DEFAULT 0,
  received_by   VARCHAR(200),
  note          TEXT,
  is_deleted    BOOLEAN DEFAULT false,
  deleted_by    VARCHAR(200),
  deleted_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────────────────────────
-- 9. EXPENSES
-- ─────────────────────────────────────────────────────────────
CREATE TABLE expenses (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  date        DATE NOT NULL,
  category    VARCHAR(100) DEFAULT 'General',
  description TEXT,
  method      VARCHAR(50) DEFAULT 'Cash',
  amount      INTEGER NOT NULL,
  created_by  VARCHAR(200),
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────────────────────────
-- 10. AUDIT LOG
-- ─────────────────────────────────────────────────────────────
CREATE TABLE audit_logs (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_name   VARCHAR(200),
  user_role   VARCHAR(50),
  action      VARCHAR(200),
  details     TEXT,
  ip_address  VARCHAR(60),
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────────────────────────
-- 11. SERVICE TEMPLATES & TRANSACTIONS
-- ─────────────────────────────────────────────────────────────
CREATE TABLE service_templates (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        VARCHAR(200) NOT NULL,
  category    VARCHAR(100),
  fee         INTEGER DEFAULT 0,
  refundable  BOOLEAN DEFAULT false,
  description TEXT,
  is_active   BOOLEAN DEFAULT true,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE service_transactions (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  student_id      UUID REFERENCES students(id),
  service_id      UUID REFERENCES service_templates(id),
  date            DATE NOT NULL,
  amount          INTEGER NOT NULL,
  qty             INTEGER DEFAULT 1,
  total           INTEGER NOT NULL,
  method          VARCHAR(50) DEFAULT 'Cash',
  collected_by    VARCHAR(200),
  challan_no      VARCHAR(50),
  status          VARCHAR(20) DEFAULT 'paid',
  refunded_amt    INTEGER DEFAULT 0,
  note            TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────────────────────────
-- 12. SUBSCRIPTION PAYMENTS (Your revenue tracking)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE subscription_payments (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id),
  plan_id         UUID REFERENCES plans(id),
  amount_pkr      INTEGER NOT NULL,
  payment_method  VARCHAR(50),
  txn_reference   VARCHAR(200),
  screenshot_url  TEXT,
  status          VARCHAR(20) DEFAULT 'pending',  -- pending | confirmed | rejected
  confirmed_by    VARCHAR(200),
  confirmed_at    TIMESTAMPTZ,
  period_start    TIMESTAMPTZ,
  period_end      TIMESTAMPTZ,
  notes           TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ─────────────────────────────────────────────────────────────
-- INDEXES for performance
-- ─────────────────────────────────────────────────────────────
CREATE INDEX idx_students_tenant    ON students(tenant_id);
CREATE INDEX idx_payments_tenant    ON payments(tenant_id);
CREATE INDEX idx_payments_student   ON payments(student_id);
CREATE INDEX idx_schedules_student  ON fee_schedules(student_id);
CREATE INDEX idx_expenses_tenant    ON expenses(tenant_id);
CREATE INDEX idx_audit_tenant       ON audit_logs(tenant_id);
CREATE INDEX idx_users_tenant       ON users(tenant_id);

-- ─────────────────────────────────────────────────────────────
-- UPDATED_AT trigger
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ language 'plpgsql';

CREATE TRIGGER trg_tenants_updated   BEFORE UPDATE ON tenants   FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_students_updated  BEFORE UPDATE ON students  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_payments_updated  BEFORE UPDATE ON payments  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
