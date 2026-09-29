CREATE TABLE invocations (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  version INTEGER,
  kind TEXT NOT NULL CHECK (kind IN ('route', 'webhook', 'cron', 'trigger')),
  name TEXT NOT NULL,
  manual INTEGER NOT NULL DEFAULT 0 CHECK (manual IN (0, 1)),
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'ok', 'error')),
  http_status INTEGER,
  error TEXT,
  stack TEXT,
  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  duration_ms INTEGER
) STRICT;

CREATE INDEX invocations_project ON invocations (project_id, id);

CREATE TABLE logs (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  invocation_id INTEGER REFERENCES invocations (id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source IN ('handler', 'runtime', 'pipeline')),
  level TEXT NOT NULL CHECK (level IN ('debug', 'info', 'warn', 'error')),
  -- Lifecycle events (start, stop, crash, deploy, auto-revert, ...) have a kind
  -- here so they can be filtered. Plain log lines have none.
  event TEXT,
  message TEXT NOT NULL,
  time TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE INDEX logs_project ON logs (project_id, id);
CREATE INDEX logs_invocation ON logs (invocation_id, id);

CREATE TABLE webhook_tokens (
  project_id INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (project_id, name)
) STRICT;
