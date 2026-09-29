-- Rebuilt so a revoked key keeps its row and the same key can be added again.
CREATE TABLE agent_ssh_keys_new (
  id INTEGER PRIMARY KEY,
  agent_id INTEGER NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  -- Key type and base64 key data, as in an authorized_keys line.
  algorithm TEXT NOT NULL,
  key_data TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  -- The key's comment when it was added, e.g. user@laptop.
  comment TEXT NOT NULL,
  -- NULL for keys added before this was recorded.
  added_via TEXT CHECK (added_via IN ('web', 'agent', 'host')),
  added_by_user_id INTEGER REFERENCES users (id) ON DELETE SET NULL,
  -- The agent key or sign-in an agent added it with. Revoking that revokes this key.
  added_by_token_id INTEGER REFERENCES agent_tokens (id) ON DELETE SET NULL,
  added_by_grant_id INTEGER REFERENCES oauth_grants (id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_used_at TEXT,
  revoked_at TEXT
) STRICT;

INSERT INTO agent_ssh_keys_new (id, agent_id, name, algorithm, key_data, fingerprint, comment, created_at, last_used_at)
SELECT id, agent_id, CASE WHEN comment = '' THEN 'SSH key' ELSE comment END, algorithm, key_data, fingerprint, comment,
  created_at, last_used_at
FROM agent_ssh_keys;

DROP TABLE agent_ssh_keys;
ALTER TABLE agent_ssh_keys_new RENAME TO agent_ssh_keys;

CREATE INDEX agent_ssh_keys_agent_id ON agent_ssh_keys (agent_id);
CREATE UNIQUE INDEX agent_ssh_keys_working_key ON agent_ssh_keys (key_data) WHERE revoked_at IS NULL;
CREATE INDEX agent_ssh_keys_added_by_token_id ON agent_ssh_keys (added_by_token_id);
CREATE INDEX agent_ssh_keys_added_by_grant_id ON agent_ssh_keys (added_by_grant_id);
