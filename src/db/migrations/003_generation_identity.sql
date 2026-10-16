-- Which prompt, output contract and settings produced a campaign version, so results are reproducible.
-- All columns are nullable: versions created before this migration (and human edits) have no generation identity,
-- and that absence is recorded as NULL rather than guessed.
ALTER TABLE campaign_versions ADD COLUMN prompt_version TEXT;
ALTER TABLE campaign_versions ADD COLUMN prompt_sha256 TEXT;
ALTER TABLE campaign_versions ADD COLUMN schema_version TEXT;
ALTER TABLE campaign_versions ADD COLUMN schema_sha256 TEXT;
ALTER TABLE campaign_versions ADD COLUMN generation_params TEXT;   -- JSON: output cap, repair/retry settings, temperature, effort, provider mode
