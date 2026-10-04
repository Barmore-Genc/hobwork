-- The last merge of each branch. A branch that still points at the merged
-- commit and nobody used for a while is deleted by housekeeping.
CREATE TABLE branch_merges (
  project_id INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  branch TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  merged_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (project_id, branch)
) STRICT;

INSERT INTO branch_merges (project_id, branch, commit_sha, merged_at)
SELECT v.project_id, r.branch, v.commit_sha, MAX(v.created_at)
FROM versions v JOIN pipeline_runs r ON r.id = v.pipeline_run_id
WHERE r.branch IS NOT NULL
GROUP BY v.project_id, r.branch;
