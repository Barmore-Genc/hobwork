-- Scans; a semicolon in a comment; does not split anything.
CREATE TABLE scans (
  id INTEGER PRIMARY KEY,
  spool_id INTEGER NOT NULL REFERENCES spools (id)
) STRICT;
