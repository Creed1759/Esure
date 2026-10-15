import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("P2 persistence SQL contract", () => {
  it("declares every required durable table and restrictive relationship", async () => {
    const sql = await readFile("migrations/001_persistence_foundation.sql", "utf8");
    for (const table of ["scenarios", "scenario_versions", "runs", "run_steps", "assertion_results", "idempotency_records", "cleanup_audit"]) {
      expect(sql).toContain(`CREATE TABLE ${table}`);
    }
    expect(sql).toContain("REFERENCES scenarios(id) ON UPDATE RESTRICT ON DELETE RESTRICT");
    expect(sql).toContain("REFERENCES scenario_versions(id) ON UPDATE RESTRICT ON DELETE RESTRICT");
    expect(sql).toContain("REFERENCES runs(id) ON UPDATE RESTRICT ON DELETE CASCADE");
    expect(sql).toContain("scenario_versions_immutable");
    expect(sql).toContain("current_setting('esure.cleanup_mode', true) = 'on'");
    expect(sql).toContain("action = 'delete_run'");
    expect(sql).toContain("OLD.origin = 'anonymous_inline'");
    expect(sql).toContain("interval '30 days'");
  });

  it("does not define storage for secrets, signed XDR, raw errors, or mainnet", async () => {
    const sql = await readFile("migrations/001_persistence_foundation.sql", "utf8");
    expect(sql).not.toMatch(/secret_seed|signed_xdr|raw_error/i);
    expect(sql).toContain("CHECK (network = 'testnet')");
  });

  it("keeps application and worker roles away from immutable versions and cleanup audit", async () => {
    const sql = await readFile("migrations/002_role_privileges.sql", "utf8");
    expect(sql).toContain("REVOKE UPDATE, DELETE, TRUNCATE ON scenario_versions FROM esure_application");
    expect(sql).toContain("REVOKE UPDATE, DELETE, TRUNCATE ON scenario_versions FROM esure_worker");
    expect(sql).toContain("REVOKE ALL ON cleanup_audit FROM esure_application");
    expect(sql).toContain("GRANT SELECT, INSERT ON cleanup_audit TO esure_maintenance");
  });

  it("adds redacted run report storage with a reversible migration", async () => {
    const up = await readFile("migrations/003_persistent_run_history.sql", "utf8");
    const down = await readFile("migrations/003_persistent_run_history.down.sql", "utf8");
    for (const column of ["run_id", "scenario_id", "scenario_version", "duration_ms", "steps", "assertions", "summary"]) {
      expect(up).toContain(column);
    }
    expect(await readFile("migrations/001_persistence_foundation.sql", "utf8")).toContain("error jsonb");
    expect(up).toContain("GRANT SELECT, INSERT, UPDATE ON runs TO esure_application");
    expect(down).toContain("DELETE FROM schema_migrations WHERE version = 3");
    expect(down).toContain("DROP COLUMN steps");
    expect(up).not.toMatch(/secret_seed|signed_xdr|raw_error/i);
  });
});
