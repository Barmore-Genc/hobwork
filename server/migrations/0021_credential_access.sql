-- What an agent token or OAuth connection may do: read only or also change
-- things, on every project or only on the listed ones. Existing credentials
-- keep full access.
ALTER TABLE agent_tokens ADD COLUMN read_only INTEGER NOT NULL DEFAULT 0 CHECK (read_only IN (0, 1));
ALTER TABLE agent_tokens ADD COLUMN all_projects INTEGER NOT NULL DEFAULT 1 CHECK (all_projects IN (0, 1));
ALTER TABLE oauth_grants ADD COLUMN read_only INTEGER NOT NULL DEFAULT 0 CHECK (read_only IN (0, 1));
ALTER TABLE oauth_grants ADD COLUMN all_projects INTEGER NOT NULL DEFAULT 1 CHECK (all_projects IN (0, 1));

-- Projects are referenced by ID so that access follows a renamed project.
CREATE TABLE agent_token_projects (
  token_id INTEGER NOT NULL REFERENCES agent_tokens (id) ON DELETE CASCADE,
  project_id INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  PRIMARY KEY (token_id, project_id)
) STRICT;

CREATE TABLE oauth_grant_projects (
  grant_id INTEGER NOT NULL REFERENCES oauth_grants (id) ON DELETE CASCADE,
  project_id INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  PRIMARY KEY (grant_id, project_id)
) STRICT;
