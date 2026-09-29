-- Phones and computers running the Hobwork app. name is what scripts use
-- (ctx.device("kaan-iphone")), unique among devices that are not revoked.
CREATE TABLE devices (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('ios', 'macos')),
  token_hash TEXT NOT NULL UNIQUE,
  -- JSON array of capability names from the app's last hello.
  capabilities TEXT NOT NULL DEFAULT '[]',
  app_version TEXT,
  push_token TEXT,
  push_environment TEXT CHECK (push_environment IN ('sandbox', 'production')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_seen_at TEXT,
  revoked_at TEXT,
  CHECK ((push_token IS NULL) = (push_environment IS NULL))
) STRICT;

CREATE UNIQUE INDEX devices_active_name ON devices (name) WHERE revoked_at IS NULL;
CREATE INDEX devices_user_id ON devices (user_id);

-- Approved pairings waiting for the app to exchange the code. The device is
-- created by the exchange, so an abandoned pairing leaves nothing behind.
CREATE TABLE device_pairing_codes (
  code_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('ios', 'macos')),
  code_challenge TEXT NOT NULL,
  expires_at TEXT NOT NULL
) STRICT;

CREATE INDEX device_pairing_codes_user_id ON device_pairing_codes (user_id);

-- One-time URLs that sign the app's web view in as the device's owner.
CREATE TABLE device_sign_in_links (
  token_hash TEXT PRIMARY KEY,
  device_id INTEGER NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
  return_to TEXT NOT NULL,
  expires_at TEXT NOT NULL
) STRICT;

CREATE INDEX device_sign_in_links_device_id ON device_sign_in_links (device_id);

-- The web session a device's web view signed in with. Removing the device
-- ends it, and each new sign-in of the device replaces it.
ALTER TABLE sessions ADD COLUMN device_id INTEGER REFERENCES devices (id) ON DELETE CASCADE;
CREATE INDEX sessions_device_id ON sessions (device_id);

-- Notifications a project sent, so an action tapped on one reaches the
-- project that sent it, once.
CREATE TABLE device_notifications (
  id TEXT PRIMARY KEY,
  device_id INTEGER NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
  project_id INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  -- JSON array of action IDs.
  actions TEXT NOT NULL,
  -- JSON the project attached, handed back with the action. NULL when none.
  data TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  answered_at TEXT
) STRICT;

CREATE INDEX device_notifications_device_id ON device_notifications (device_id);
CREATE INDEX device_notifications_project_id ON device_notifications (project_id);
CREATE INDEX device_notifications_created_at ON device_notifications (created_at);
