-- A Live Activity a hob started. id is what devices know it by
-- (HobworkActivityAttributes.id); key is the hob's own ID for it.
CREATE TABLE live_activities (
  id TEXT PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  -- JSON: what it shows, the button with its route, data, staleAt, relevance.
  content TEXT NOT NULL,
  -- "restart" or "stillRunning": what happens before iOS's 8 hour limit.
  past_limit TEXT NOT NULL,
  -- Goes up with every start and update, so devices that missed one get the
  -- latest content later.
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  ended_at TEXT,
  UNIQUE (project_id, key)
) STRICT;

CREATE INDEX live_activities_updated_at ON live_activities (updated_at);

-- A device that shows a Live Activity.
CREATE TABLE live_activity_devices (
  activity_id TEXT NOT NULL REFERENCES live_activities (id) ON DELETE CASCADE,
  device_id INTEGER NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
  -- starting (sent, the app has not reported it runs), active, dismissed (the
  -- person swiped it away there), ended.
  state TEXT NOT NULL,
  -- ActivityKit's ID of the activity on the device. A restart makes a new
  -- one, and reports about the old one are ignored.
  activity TEXT,
  -- The relay's ID of the activity's push token.
  token TEXT,
  -- When the activity on the device started, for iOS's 8 hour limit.
  started_at TEXT NOT NULL,
  -- What the device got last: the revision, when, and the state as sent.
  sent_revision INTEGER NOT NULL DEFAULT 0,
  sent_at TEXT,
  sent_state TEXT,
  -- The activity switched to "Still running" past the limit.
  still_running INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (activity_id, device_id)
) STRICT;

CREATE INDEX live_activity_devices_device_id ON live_activity_devices (device_id);

-- The relay's ID of the app's push-to-start token, which lets the host start
-- Live Activities on the device while its app is closed.
ALTER TABLE devices ADD COLUMN live_activity_start_token TEXT;
