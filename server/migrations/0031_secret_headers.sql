-- JSON array of header names, besides Authorization, that Hobwork fills the
-- secret into. Existing secrets get none, so they only work in Authorization.
ALTER TABLE secrets ADD COLUMN headers TEXT NOT NULL DEFAULT '[]';
