-- Branch previews run handlers of a branch's latest commit. Their invocations
-- and log lines name the branch; NULL is the deployed version on main.
ALTER TABLE invocations ADD COLUMN branch TEXT;
ALTER TABLE logs ADD COLUMN branch TEXT;

CREATE INDEX invocations_project_branch ON invocations (project_id, branch, id);

-- Webhook URLs of a branch preview, separate from main's so a branch never
-- answers main's URL.
CREATE TABLE branch_webhook_tokens (
  project_id INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  branch TEXT NOT NULL,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (project_id, branch, name)
) STRICT;

-- A person let this branch's handlers call Home Assistant services and fire
-- events. Without a row, branch handlers only read states.
CREATE TABLE branch_ha_approvals (
  project_id INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  branch TEXT NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  granted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (project_id, branch)
) STRICT;
