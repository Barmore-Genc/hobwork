CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  -- Only verified addresses are stored, because the allowlist matches on them.
  email TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_login_at TEXT
) STRICT;

-- Separate from users so one user can later sign in with passkeys as well.
CREATE TABLE user_identities (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (issuer, subject)
) STRICT;

CREATE INDEX user_identities_user_id ON user_identities (user_id);

CREATE TABLE sessions (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at TEXT NOT NULL
) STRICT;

CREATE INDEX sessions_user_id ON sessions (user_id);

ALTER TABLE versions ADD COLUMN user_id INTEGER REFERENCES users (id) ON DELETE SET NULL;
