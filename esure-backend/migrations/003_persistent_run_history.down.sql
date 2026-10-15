ALTER TABLE runs DISABLE TRIGGER runs_cleanup_guard;
DELETE FROM runs WHERE scenario_version_id IS NULL;
ALTER TABLE runs ENABLE TRIGGER runs_cleanup_guard;

DROP INDEX IF EXISTS runs_report_expiry_idx;
DROP INDEX IF EXISTS runs_run_id_idx;
ALTER TABLE runs
  DROP COLUMN run_id,
  DROP COLUMN scenario_id,
  DROP COLUMN scenario_version,
  DROP COLUMN scenario_schema_version,
  DROP COLUMN scenario_content_hash,
  DROP COLUMN duration_ms,
  DROP COLUMN steps,
  DROP COLUMN assertions,
  DROP COLUMN summary;

ALTER TABLE runs DROP CONSTRAINT runs_status_check;
ALTER TABLE runs ADD CONSTRAINT runs_status_check
  CHECK (status IN ('requested', 'claimed', 'running', 'passed', 'failed', 'interrupted', 'cancelled'));
ALTER TABLE runs
  ALTER COLUMN scenario_version_id SET NOT NULL,
  ALTER COLUMN network DROP DEFAULT;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'esure_application') THEN
    REVOKE UPDATE ON runs FROM esure_application;
  END IF;
END $$;
DELETE FROM schema_migrations WHERE version = 3 AND filename = '003_persistent_run_history.sql';
