-- Sign-in flows in progress. The browser only holds a random ID (hashed here),
-- so a page on a sibling subdomain cannot plant its own state, nonce or PKCE
-- verifier.
CREATE TABLE oidc_flows (
  id_hash TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  nonce TEXT NOT NULL,
  verifier TEXT NOT NULL,
  return_to TEXT NOT NULL,
  expires_at TEXT NOT NULL
) STRICT;
