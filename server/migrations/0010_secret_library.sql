-- Secrets move from per project and global scopes to one library of secrets
-- that are assigned to projects. Each assignment picks the env var name the
-- project sees.
ALTER TABLE secrets RENAME TO secrets_scoped;
DROP INDEX secrets_project_name;
DROP INDEX secrets_global_name;

CREATE TABLE secrets (
  id INTEGER PRIMARY KEY,
  -- A label for people, not an env var name.
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  -- AES-256-GCM: 12-byte IV, 16-byte tag, then the ciphertext.
  value BLOB NOT NULL,
  -- JSON array of host patterns the value may be sent to.
  hosts TEXT NOT NULL,
  -- The additional authenticated data a migrated value is still encrypted
  -- with. The host re-encrypts such values with the key and clears it.
  legacy_aad TEXT,
  created_by_user_id INTEGER REFERENCES users (id) ON DELETE SET NULL,
  updated_by_user_id INTEGER REFERENCES users (id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

-- Neither user nor agent: assigned on the host command line or by this migration.
CREATE TABLE secret_assignments (
  project_id INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  secret_id INTEGER NOT NULL REFERENCES secrets (id) ON DELETE CASCADE,
  env_name TEXT NOT NULL,
  assigned_by_user_id INTEGER REFERENCES users (id) ON DELETE SET NULL,
  assigned_by_agent_id INTEGER REFERENCES agents (id) ON DELETE SET NULL,
  assigned_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (project_id, secret_id),
  UNIQUE (project_id, env_name)
) STRICT;

CREATE INDEX secret_assignments_secret ON secret_assignments (secret_id);

-- Old names become library names. A name used by more than one old secret
-- (a global one and project ones, or several projects) keeps it for the global
-- secret, and project secrets get the project name appended. Old names are
-- env var style, so "NAME (project)" cannot clash with another old name.
INSERT INTO secrets (id, name, value, hosts, legacy_aad, created_at, updated_at)
SELECT
  s.id,
  CASE
    WHEN s.project_id IS NULL THEN s.name
    WHEN (SELECT count(*) FROM secrets_scoped o WHERE o.name = s.name) = 1 THEN s.name
    ELSE s.name || ' (' || p.name || ')'
  END,
  s.value,
  s.hosts,
  'hobwork-secret:v1:' || coalesce(s.project_id, 'global') || ':' || s.name,
  s.created_at,
  s.updated_at
FROM secrets_scoped s LEFT JOIN projects p ON p.id = s.project_id;

INSERT INTO secret_assignments (project_id, secret_id, env_name)
SELECT project_id, id, name FROM secrets_scoped WHERE project_id IS NOT NULL;

-- Global secrets go to every project that did not override them.
INSERT INTO secret_assignments (project_id, secret_id, env_name)
SELECT p.id, g.id, g.name
FROM secrets_scoped g CROSS JOIN projects p
WHERE g.project_id IS NULL
  AND NOT EXISTS (SELECT 1 FROM secrets_scoped o WHERE o.project_id = p.id AND o.name = g.name);

DROP TABLE secrets_scoped;
