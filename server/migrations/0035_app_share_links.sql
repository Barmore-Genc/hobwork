-- Links an agent hands out (show_hob) that open one app origin without a
-- Hobwork session, until they expire. A link belongs to the agent credential
-- that made it: revoking the token or OAuth connection ends its links, and a
-- read-only credential makes read-only links. branch is NULL for main.
CREATE TABLE app_share_links (
  id INTEGER PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  project_id INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  branch TEXT,
  agent_id INTEGER NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
  token_id INTEGER REFERENCES agent_tokens (id) ON DELETE CASCADE,
  grant_id INTEGER REFERENCES oauth_grants (id) ON DELETE CASCADE,
  read_only INTEGER NOT NULL CHECK (read_only IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at TEXT NOT NULL,
  CHECK (token_id IS NULL OR grant_id IS NULL)
) STRICT;

CREATE INDEX app_share_links_project_id ON app_share_links (project_id);
CREATE INDEX app_share_links_agent_id ON app_share_links (agent_id);
CREATE INDEX app_share_links_token_id ON app_share_links (token_id);
CREATE INDEX app_share_links_grant_id ON app_share_links (grant_id);
CREATE INDEX app_share_links_expires_at ON app_share_links (expires_at);
