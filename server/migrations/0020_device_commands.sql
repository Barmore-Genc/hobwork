-- Calls from handlers to device capabilities other than notifications. They
-- may reach the device by socket, push or on its next hello, so they are
-- kept until answered or expired, and the first result wins.
CREATE TABLE device_commands (
  id TEXT PRIMARY KEY,
  device_id INTEGER NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
  project_id INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  -- Invocations are pruned sooner than commands, so this is not a reference.
  invocation INTEGER,
  capability TEXT NOT NULL,
  method TEXT NOT NULL,
  -- JSON, as sent to the device.
  args TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'failed', 'expired')),
  -- JSON: the value for done, { code, message } for failed.
  result TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  answered_at TEXT
) STRICT;

CREATE INDEX device_commands_pending ON device_commands (device_id, created_at) WHERE status = 'pending';
CREATE INDEX device_commands_project_id ON device_commands (project_id);
CREATE INDEX device_commands_created_at ON device_commands (created_at);

-- NFC tags written for a project. Tags hold <public URL>/nfc/<id>, and a scan
-- runs the triggers of the project that wrote it.
CREATE TABLE nfc_tags (
  id TEXT PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE INDEX nfc_tags_project_id ON nfc_tags (project_id);
