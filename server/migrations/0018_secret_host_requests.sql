-- Hosts an agent asked for. They replace the secret's hosts once a person approves.
CREATE TABLE secret_host_requests (
  id INTEGER PRIMARY KEY,
  secret_id INTEGER NOT NULL REFERENCES secrets (id) ON DELETE CASCADE,
  agent_id INTEGER REFERENCES agents (id) ON DELETE SET NULL,
  -- JSON array of normalized hosts.
  hosts TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  -- NULL while it waits for an answer. A newer request for the same secret supersedes it.
  decision TEXT CHECK (decision IN ('approved', 'denied', 'superseded')),
  decided_at TEXT,
  decided_by_user_id INTEGER REFERENCES users (id) ON DELETE SET NULL
) STRICT;

CREATE INDEX secret_host_requests_secret_id ON secret_host_requests (secret_id);
