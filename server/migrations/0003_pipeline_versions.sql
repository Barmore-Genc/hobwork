CREATE TABLE pipeline_runs (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  branch TEXT,
  commit_sha TEXT NOT NULL,
  agent_id INTEGER REFERENCES agents (id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'passed', 'failed')),
  failed_step TEXT,
  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  finished_at TEXT
) STRICT;

CREATE INDEX pipeline_runs_project_branch ON pipeline_runs (project_id, branch, id);

CREATE TABLE pipeline_steps (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES pipeline_runs (id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'passed', 'failed', 'skipped')),
  output TEXT NOT NULL DEFAULT '',
  duration_ms INTEGER,
  UNIQUE (run_id, position)
) STRICT;

CREATE TABLE versions (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  number INTEGER NOT NULL,
  commit_sha TEXT NOT NULL,
  summary TEXT NOT NULL,
  agent_id INTEGER REFERENCES agents (id) ON DELETE SET NULL,
  pipeline_run_id INTEGER REFERENCES pipeline_runs (id) ON DELETE SET NULL,
  restored_from INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (project_id, number)
) STRICT;
