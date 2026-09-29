-- Rebuilt so agents can turn it on too: exactly one of user_id and agent_id is set.
CREATE TABLE branch_ha_approvals_new (
  project_id INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  branch TEXT NOT NULL,
  user_id INTEGER REFERENCES users (id) ON DELETE CASCADE,
  agent_id INTEGER REFERENCES agents (id) ON DELETE CASCADE,
  granted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (project_id, branch),
  CHECK ((user_id IS NULL) <> (agent_id IS NULL))
) STRICT;

INSERT INTO branch_ha_approvals_new (project_id, branch, user_id, granted_at)
SELECT project_id, branch, user_id, granted_at FROM branch_ha_approvals;

DROP TABLE branch_ha_approvals;
ALTER TABLE branch_ha_approvals_new RENAME TO branch_ha_approvals;
