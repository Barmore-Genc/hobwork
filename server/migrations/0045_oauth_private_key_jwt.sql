-- The jti of each private_key_jwt client assertion until it expires, so an
-- assertion is accepted once (RFC 7523 3).
CREATE TABLE oauth_client_assertions (
  client_id TEXT NOT NULL,
  jti TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (client_id, jti)
) STRICT;

CREATE INDEX oauth_client_assertions_expires_at ON oauth_client_assertions (expires_at);

-- Registered clients may use private_key_jwt with the keys at jwks_uri.
-- SQLite cannot change the CHECK in place, so the table is rebuilt.
ALTER TABLE oauth_clients RENAME TO oauth_clients_old;

CREATE TABLE oauth_clients (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  uri TEXT,
  redirect_uris TEXT NOT NULL,
  -- Null unless the client uses client_secret_basic or client_secret_post.
  secret_hash TEXT,
  auth_method TEXT NOT NULL CHECK (auth_method IN ('none', 'client_secret_basic', 'client_secret_post', 'private_key_jwt')),
  -- Set for private_key_jwt.
  jwks_uri TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

INSERT INTO oauth_clients (id, name, uri, redirect_uris, secret_hash, auth_method, created_at)
SELECT id, name, uri, redirect_uris, secret_hash, auth_method, created_at FROM oauth_clients_old;

DROP TABLE oauth_clients_old;
