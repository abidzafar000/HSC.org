-- HSC application schema. Business records are initialized separately and empty.
CREATE TABLE IF NOT EXISTS application (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  branch_id TEXT,
  password TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  permissions TEXT
);
ALTER TABLE users ADD COLUMN IF NOT EXISTS permissions TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique ON users (email);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions (user_id);
CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions (expires);
CREATE TABLE IF NOT EXISTS login_limits (
  id TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL,
  until BIGINT NOT NULL
);
