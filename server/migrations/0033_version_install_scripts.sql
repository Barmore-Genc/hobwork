-- Packages a version added to or removed from allowBuilds in pnpm-workspace.yaml
-- compared to the version before it, as JSON arrays of package names.
ALTER TABLE versions ADD COLUMN builds_added TEXT NOT NULL DEFAULT '[]';
ALTER TABLE versions ADD COLUMN builds_removed TEXT NOT NULL DEFAULT '[]';
