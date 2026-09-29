-- The WebAuthn user handle. Random, so it reveals nothing about the user.
ALTER TABLE users ADD COLUMN webauthn_id TEXT;
CREATE UNIQUE INDEX users_webauthn_id ON users (webauthn_id);

CREATE TABLE passkeys (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  credential_id TEXT NOT NULL UNIQUE,
  public_key BLOB NOT NULL,
  counter INTEGER NOT NULL,
  transports TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_used_at TEXT
) STRICT;

CREATE INDEX passkeys_user_id ON passkeys (user_id);

-- Challenges of passkey ceremonies in progress, each usable once.
CREATE TABLE webauthn_challenges (
  id TEXT PRIMARY KEY,
  challenge TEXT NOT NULL,
  -- Set for registration, null for sign-in.
  user_id INTEGER REFERENCES users (id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
) STRICT;

-- One-time sign-in links from the sign-in-link command.
CREATE TABLE sign_in_links (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
) STRICT;
