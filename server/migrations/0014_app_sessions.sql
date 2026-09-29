-- Project UIs run on their own origin with their own session cookie. A code
-- hands a Hobwork session over to one app origin; the app session it becomes
-- lives as long as that Hobwork session, so signing out of Hobwork ends it.
-- branch is NULL for the deployed version on main.

CREATE TABLE app_codes (
  code_hash TEXT PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  project_id INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  branch TEXT,
  expires_at TEXT NOT NULL
) STRICT;

CREATE TABLE app_sessions (
  id INTEGER PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  session_id INTEGER NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  project_id INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  branch TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE INDEX app_sessions_session_id ON app_sessions (session_id);
CREATE INDEX app_sessions_project_id ON app_sessions (project_id);
CREATE INDEX app_codes_session_id ON app_codes (session_id);
CREATE INDEX app_codes_project_id ON app_codes (project_id);
