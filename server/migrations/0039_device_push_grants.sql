-- Push goes through the relay: the app's grant for this host and the app's
-- X25519 key for this pairing (standard base64). The relay holds the APNs
-- token, so the host forgets the ones it stored.
ALTER TABLE devices ADD COLUMN push_grant TEXT;
ALTER TABLE devices ADD COLUMN push_key TEXT;
UPDATE devices SET push_token = NULL, push_environment = NULL;
