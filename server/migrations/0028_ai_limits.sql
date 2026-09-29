-- Which AI models projects may use through OpenRouter and how much, set by
-- people in the web UI. One row at most; without it the built-in defaults apply.
CREATE TABLE ai_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  -- JSON array of model patterns. NULL allows every model.
  models TEXT,
  -- JSON: { throttle, requestsPerMinute, requestsPerHour, costPerDay, costPerMonth }.
  limits TEXT NOT NULL,
  updated_by_user_id INTEGER REFERENCES users (id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

-- A project's own settings. NULL columns use the host-wide ones.
CREATE TABLE project_ai_settings (
  project_id INTEGER PRIMARY KEY REFERENCES projects (id) ON DELETE CASCADE,
  -- Narrows the host-wide models: a model must match both lists.
  models TEXT,
  limits TEXT,
  updated_by_user_id INTEGER REFERENCES users (id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

-- One row per request a project VM sent to OpenRouter, including the ones
-- Hobwork refused. Limits count the rows that were not refused.
CREATE TABLE ai_requests (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  -- NULL for the deployed version.
  branch TEXT,
  source TEXT NOT NULL CHECK (source IN ('runtime', 'preview', 'workspace')),
  path TEXT NOT NULL,
  model TEXT,
  refused TEXT CHECK (refused IN ('model', 'rate', 'spend')),
  -- The HTTP status the VM got. NULL while the request runs.
  status INTEGER,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  -- In US dollars, as OpenRouter reports it.
  cost REAL,
  started_at TEXT NOT NULL,
  finished_at TEXT
) STRICT;

CREATE INDEX ai_requests_project_started ON ai_requests (project_id, started_at);
CREATE INDEX ai_requests_started ON ai_requests (started_at);
