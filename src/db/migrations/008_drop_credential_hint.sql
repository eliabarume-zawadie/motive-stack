-- Milestone 4.4b: stop keeping any fragment of a secret. Migration 007 created workspace_credentials with a "last4" hint column; nothing
-- shows it any more and it serves no purpose that justifies keeping a partial secret. This is a FORWARD migration: 007 stays exactly as
-- it was applied (the runner records applied filenames and never re-runs or edits them), and a database that never saw 007 gets both.
-- DROP COLUMN rewrites the table's rows without the column; deleted content is overwritten (secure_delete is on for every connection).
ALTER TABLE workspace_credentials DROP COLUMN last4;
