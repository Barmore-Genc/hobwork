-- Problems across all projects (blocked requests, rollbacks, DB warnings)
-- are lifecycle events, a small part of the log.
CREATE INDEX logs_events_time ON logs (time) WHERE event IS NOT NULL;
