-- Starred hobs come first in hob lists. position orders hobs within the starred
-- and the other hobs; NULL until a hob is moved, and those come last by name,
-- so new hobs land at the end.
ALTER TABLE projects ADD COLUMN starred INTEGER NOT NULL DEFAULT 0 CHECK (starred IN (0, 1));
ALTER TABLE projects ADD COLUMN position INTEGER;

CREATE TABLE project_tags (
  project_id INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (project_id, tag)
) STRICT;

CREATE INDEX project_tags_tag ON project_tags (tag);
