-- project_id is NULL for global secrets, which every project gets.
CREATE TABLE secrets (
  id INTEGER PRIMARY KEY,
  project_id INTEGER REFERENCES projects (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  -- AES-256-GCM: 12-byte IV, 16-byte tag, then the ciphertext.
  value BLOB NOT NULL,
  -- JSON array of host patterns the value may be sent to.
  hosts TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE UNIQUE INDEX secrets_project_name ON secrets (project_id, name) WHERE project_id IS NOT NULL;
CREATE UNIQUE INDEX secrets_global_name ON secrets (name) WHERE project_id IS NULL;
