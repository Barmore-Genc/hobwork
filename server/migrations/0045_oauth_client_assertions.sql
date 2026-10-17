-- The jti of each private_key_jwt client assertion until it expires, so an
-- assertion is accepted once (RFC 7523 3).
CREATE TABLE oauth_client_assertions (
  client_id TEXT NOT NULL,
  jti TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (client_id, jti)
) STRICT;

CREATE INDEX oauth_client_assertions_expires_at ON oauth_client_assertions (expires_at);
