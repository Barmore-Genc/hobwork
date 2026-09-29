-- The Home Assistant services a hob's handlers may call: a whole domain
-- ('light') or one service ('light.turn_on'). A hob without rows calls none.
CREATE TABLE project_ha_services (
  project_id INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  entry TEXT NOT NULL,
  PRIMARY KEY (project_id, entry)
) STRICT;

-- Hobs that existed before the list get the domains their deployed code
-- already calls. Reading the code needs git, so the host does it on start
-- and removes the row when done.
CREATE TABLE project_ha_services_backfill (
  project_id INTEGER PRIMARY KEY REFERENCES projects (id) ON DELETE CASCADE
) STRICT;

INSERT INTO project_ha_services_backfill (project_id) SELECT id FROM projects;
