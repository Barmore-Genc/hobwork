-- The Home Assistant events a hob's handlers may fire are entries of
-- project_ha_services written as 'event:<type>'. Hobs that existed before get
-- the events their deployed code already fires. Reading the code needs git, so
-- the host does it on start and removes the row when done.
CREATE TABLE project_ha_events_backfill (
  project_id INTEGER PRIMARY KEY REFERENCES projects (id) ON DELETE CASCADE
) STRICT;

INSERT INTO project_ha_events_backfill (project_id) SELECT id FROM projects;
