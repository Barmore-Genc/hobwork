CREATE TABLE registrations (
  id TEXT PRIMARY KEY,
  secret_hash BLOB NOT NULL,
  token TEXT,
  environment TEXT,
  pending_token TEXT,
  pending_environment TEXT,
  proof_nonce TEXT,
  proof_expires_at INTEGER,
  filtering INTEGER NOT NULL,
  attest_key_id BLOB,
  attest_public_key BLOB,
  attest_counter INTEGER,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL,
  gone_at INTEGER
) STRICT;

CREATE UNIQUE INDEX registrations_token ON registrations (token) WHERE token IS NOT NULL;

CREATE TABLE grants (
  id TEXT PRIMARY KEY,
  registration_id TEXT NOT NULL REFERENCES registrations (id) ON DELETE CASCADE,
  pairing TEXT NOT NULL,
  public_key BLOB NOT NULL,
  created_at INTEGER NOT NULL,
  renewed_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  next_renewal_push_at INTEGER NOT NULL,
  UNIQUE (registration_id, pairing)
) STRICT;

CREATE INDEX grants_next_renewal_push_at ON grants (next_renewal_push_at);

CREATE TABLE request_nonces (
  grant_id TEXT NOT NULL,
  nonce TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (grant_id, nonce)
) STRICT, WITHOUT ROWID;

CREATE TABLE attest_challenges (
  challenge TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
) STRICT;

CREATE TABLE ip_keys (
  id INTEGER PRIMARY KEY,
  key BLOB NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE events (
  id INTEGER PRIMARY KEY,
  at INTEGER NOT NULL,
  ip_hash TEXT,
  registration_id TEXT,
  grant_id TEXT,
  action TEXT NOT NULL,
  result TEXT NOT NULL,
  apns_status INTEGER
) STRICT;

CREATE INDEX events_at ON events (at);
