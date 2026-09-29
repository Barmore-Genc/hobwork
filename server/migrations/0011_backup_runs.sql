CREATE TABLE backup_runs (
  id INTEGER PRIMARY KEY,
  trigger TEXT NOT NULL CHECK (trigger IN ('schedule', 'manual')),
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'succeeded', 'failed')),
  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  finished_at TEXT,
  duration_ms INTEGER,
  -- Kopia snapshot manifest ID.
  snapshot_id TEXT,
  total_bytes INTEGER,
  file_count INTEGER,
  -- New data sent to the bucket. Unchanged chunks are not uploaded again.
  uploaded_bytes INTEGER,
  error TEXT
) STRICT;
