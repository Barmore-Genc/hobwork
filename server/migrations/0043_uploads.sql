-- Tokens that let scripts store files through an upload of hobwork.json
-- (`uploads`), like webhook tokens: only the hash is kept.
CREATE TABLE upload_tokens (
  project_id INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (project_id, name)
) STRICT;

-- An upload sent in chunks that has not arrived in full yet. Its bytes so far
-- are in files.tmp/upload-<id> next to the hob's files. user_id is who started
-- it from the app, NULL for an upload token; only they can continue it.
CREATE TABLE chunked_uploads (
  id TEXT PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  branch TEXT,
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  size INTEGER NOT NULL,
  received INTEGER NOT NULL DEFAULT 0,
  content_type TEXT,
  user_id INTEGER REFERENCES users (id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE INDEX chunked_uploads_updated ON chunked_uploads (updated_at);
