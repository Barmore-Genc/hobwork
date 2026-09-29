-- The Home Assistant connection set in the web UI. One row at most.
CREATE TABLE homeassistant_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  url TEXT NOT NULL,
  -- AES-256-GCM with the secrets key: 12-byte IV, 16-byte tag, then the ciphertext.
  token BLOB NOT NULL,
  updated_by_user_id INTEGER REFERENCES users (id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;
