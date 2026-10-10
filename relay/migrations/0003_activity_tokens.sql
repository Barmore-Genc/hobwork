CREATE TABLE activity_tokens (
  id TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL REFERENCES grants (id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  token TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER
) STRICT;

CREATE INDEX activity_tokens_grant_id ON activity_tokens (grant_id);
CREATE INDEX activity_tokens_expires_at ON activity_tokens (expires_at) WHERE expires_at IS NOT NULL;
