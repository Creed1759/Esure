ALTER TABLE runs
  ALTER COLUMN scenario_version_id DROP NOT NULL,
  ALTER COLUMN network SET DEFAULT 'testnet';

ALTER TABLE runs DROP CONSTRAINT runs_status_check;
ALTER TABLE runs ADD CONSTRAINT runs_status_check
  CHECK (status IN ('requested', 'validating', 'claimed', 'running', 'passed', 'failed', 'interrupted', 'cancelled'));

ALTER TABLE runs
  ADD COLUMN run_id uuid,
  ADD COLUMN scenario_id text,
  ADD COLUMN scenario_version integer,
  ADD COLUMN scenario_schema_version integer NOT NULL DEFAULT 1 CHECK (scenario_schema_version = 1),
  ADD COLUMN scenario_content_hash text,
  ADD COLUMN duration_ms bigint CHECK (duration_ms IS NULL OR duration_ms >= 0),
  ADD COLUMN steps jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(steps) = 'array'),
  ADD COLUMN assertions jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(assertions) = 'array'),
  ADD COLUMN summary jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(summary) = 'object');

UPDATE runs SET run_id = id;
ALTER TABLE runs ALTER COLUMN run_id SET NOT NULL;
CREATE UNIQUE INDEX runs_run_id_idx ON runs (run_id);
CREATE INDEX runs_report_expiry_idx ON runs (completed_at) WHERE completed_at IS NOT NULL;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'esure_application') THEN
    GRANT SELECT, INSERT, UPDATE ON runs TO esure_application;
  END IF;
END $$;
