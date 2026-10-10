-- IANA time zone of the person, e.g. "Europe/Istanbul". The app and the web UI
-- report it, unless the person chose one in Settings (time_zone_manual = 1).
ALTER TABLE users ADD COLUMN time_zone TEXT;
ALTER TABLE users ADD COLUMN time_zone_manual INTEGER NOT NULL DEFAULT 0 CHECK (time_zone_manual IN (0, 1));

-- When the person last used the device: the app came to the foreground, sent
-- an event, or its web view called a hob. last_seen_at also counts pings of a
-- connection that stays open in the background.
ALTER TABLE devices ADD COLUMN last_active_at TEXT;
