-- Names a project had before it was renamed. Webhook URLs and app links that
-- still use an old name reach the project by it, until a project takes that
-- name again.
CREATE TABLE project_renames (
  name TEXT PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  renamed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE INDEX project_renames_project_id ON project_renames (project_id);
