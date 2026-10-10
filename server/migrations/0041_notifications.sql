-- A notification a hob sent, to one or more devices. id is what devices show
-- it under, so a later send, update or withdraw reaches the same notification
-- on every device. key is the hob's own ID for it (the same as id when the hob
-- chose none).
CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  -- JSON: title, body, actions, data, interruptionLevel, sound, thread, open.
  content TEXT NOT NULL,
  -- Goes up with every send and update, so the app tells a new version from a
  -- repeat of one it already showed.
  revision INTEGER NOT NULL DEFAULT 1,
  -- While waiting for deliverAt: when to send it and to whom, as JSON
  -- { "device": <device id> } or { "person": <user id>, "devices": "all" | "lastActive" }.
  deliver_at TEXT,
  target TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  withdrawn_at TEXT,
  UNIQUE (project_id, key)
) STRICT;

CREATE INDEX notifications_deliver_at ON notifications (deliver_at) WHERE deliver_at IS NOT NULL;
CREATE INDEX notifications_updated_at ON notifications (updated_at);

-- A device a notification went to.
CREATE TABLE notification_deliveries (
  notification_id TEXT NOT NULL REFERENCES notifications (id) ON DELETE CASCADE,
  device_id INTEGER NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  delivered_at TEXT NOT NULL,
  -- An action was tapped on this revision. The app may send a tap twice, and
  -- the hob sees it once.
  answered_at TEXT,
  withdrawn_at TEXT,
  -- The app said it removed the notification. Until then every hello sends
  -- the withdrawal again.
  removed_at TEXT,
  PRIMARY KEY (notification_id, device_id)
) STRICT;

CREATE INDEX notification_deliveries_device_id ON notification_deliveries (device_id);

INSERT INTO notifications (id, project_id, key, content, created_at, updated_at)
SELECT
  id,
  project_id,
  id,
  CASE WHEN data IS NULL
    THEN json_object('title', '', 'actions', (SELECT json_group_array(json_object('id', value, 'title', value)) FROM json_each(actions)))
    ELSE json_object('title', '', 'actions', (SELECT json_group_array(json_object('id', value, 'title', value)) FROM json_each(actions)), 'data', json(data))
  END,
  created_at,
  created_at
FROM device_notifications;

INSERT INTO notification_deliveries (notification_id, device_id, revision, delivered_at, answered_at)
SELECT id, device_id, 1, created_at, answered_at FROM device_notifications;

DROP TABLE device_notifications;
