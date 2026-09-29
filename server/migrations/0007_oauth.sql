-- Clients that registered through dynamic client registration. Clients that
-- identify with a metadata document URL are fetched on demand, not stored.
CREATE TABLE oauth_clients (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  uri TEXT,
  redirect_uris TEXT NOT NULL,
  -- Null for public clients (token_endpoint_auth_method "none").
  secret_hash TEXT,
  auth_method TEXT NOT NULL CHECK (auth_method IN ('none', 'client_secret_basic', 'client_secret_post')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

-- Authorization requests waiting for the user to approve or deny them.
CREATE TABLE oauth_requests (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  state TEXT,
  code_challenge TEXT NOT NULL,
  resource TEXT NOT NULL,
  scope TEXT,
  expires_at TEXT NOT NULL
) STRICT;

-- One approved connection of a client. Revoking it ends all its tokens.
CREATE TABLE oauth_grants (
  id INTEGER PRIMARY KEY,
  agent_id INTEGER NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
  client_id TEXT NOT NULL,
  client_name TEXT NOT NULL,
  redirect_host TEXT NOT NULL,
  resource TEXT NOT NULL,
  scope TEXT,
  user_id INTEGER REFERENCES users (id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_used_at TEXT,
  revoked_at TEXT
) STRICT;

CREATE INDEX oauth_grants_agent_id ON oauth_grants (agent_id);

CREATE TABLE oauth_codes (
  code_hash TEXT PRIMARY KEY,
  grant_id INTEGER NOT NULL REFERENCES oauth_grants (id) ON DELETE CASCADE,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
) STRICT;

CREATE TABLE oauth_tokens (
  id INTEGER PRIMARY KEY,
  grant_id INTEGER NOT NULL REFERENCES oauth_grants (id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  -- Set when a refresh token was exchanged. Using it again means it leaked.
  used_at TEXT,
  revoked_at TEXT
) STRICT;

CREATE INDEX oauth_tokens_grant_id ON oauth_tokens (grant_id);
