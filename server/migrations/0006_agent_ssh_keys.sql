CREATE TABLE agent_ssh_keys (
  id INTEGER PRIMARY KEY,
  agent_id INTEGER NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
  -- Key type and base64 key data, as in an authorized_keys line.
  algorithm TEXT NOT NULL,
  key_data TEXT NOT NULL UNIQUE,
  fingerprint TEXT NOT NULL,
  -- The key's comment when it was added, e.g. user@laptop.
  comment TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_used_at TEXT
) STRICT;

CREATE INDEX agent_ssh_keys_agent_id ON agent_ssh_keys (agent_id);
