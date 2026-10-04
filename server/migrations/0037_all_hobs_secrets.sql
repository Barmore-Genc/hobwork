-- Secrets every hob gets under an env name, unless the hob has its own secret
-- under that name. Set by people in the web UI, like the OpenRouter API key in
-- the AI settings.
CREATE TABLE all_hobs_secrets (
  env_name TEXT PRIMARY KEY,
  secret_id INTEGER NOT NULL UNIQUE REFERENCES secrets (id) ON DELETE CASCADE,
  assigned_by_user_id INTEGER REFERENCES users (id) ON DELETE SET NULL,
  assigned_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;
