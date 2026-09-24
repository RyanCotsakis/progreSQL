CREATE TABLE auth_session (
  token_hash TEXT PRIMARY KEY,
  credential_version TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX ix_auth_session_expiry ON auth_session(expires_at);
CREATE TABLE auth_rate_limit (
  bucket TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  attempts INTEGER NOT NULL
);
CREATE TABLE auth_totp (
  credential_version TEXT PRIMARY KEY,
  last_step INTEGER NOT NULL
);
