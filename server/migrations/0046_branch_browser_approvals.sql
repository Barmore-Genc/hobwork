-- A person or an agent let this branch's handlers use the browser. Without a
-- row, a branch preview may not open a page.
CREATE TABLE branch_browser_approvals (
  project_id INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  branch TEXT NOT NULL,
  user_id INTEGER REFERENCES users (id) ON DELETE CASCADE,
  agent_id INTEGER REFERENCES agents (id) ON DELETE CASCADE,
  granted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (project_id, branch),
  CHECK ((user_id IS NULL) <> (agent_id IS NULL))
) STRICT;
