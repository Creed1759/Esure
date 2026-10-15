import { mkdtemp, cp, appendFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Database, runMigrations } from "../src/database.js";
import { createScenarioRegistry } from "../src/scenarios.js";
import { PublishedScenarioRepository, reconcileFixture } from "../src/published-scenarios.js";
import { prepareScenario } from "../src/scenario-loader.js";
import type { AppConfig } from "../src/config.js";
import { buildApp } from "../src/app.js";

const port = 55_432;
let postgres: EmbeddedPostgres;
let database: Database;
let directory: string;

const postgresAvailable = process.platform !== "win32" || existsSync("C:/Windows/System32/VCRUNTIME140.dll") ||
  existsSync("node_modules/@embedded-postgres/windows-x64/native/bin/VCRUNTIME140.dll");

(postgresAvailable ? describe.sequential : describe.skip)("PostgreSQL persistence foundation", () => {
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "esure-postgres-"));
    postgres = new EmbeddedPostgres({ databaseDir: directory, user: "postgres", password: "test-password", port, persistent: true, onLog: () => undefined, onError: () => undefined });
    await postgres.initialise();
    await postgres.start();
    database = new Database(databaseConfig(`postgresql://postgres:test-password@127.0.0.1:${port}/postgres`));
    const roles = await import("node:fs/promises").then(({ readFile }) => readFile(resolve("database/bootstrap-roles.sql"), "utf8"));
    await database.query(roles);
  }, 60_000);

  afterAll(async () => {
    await database?.close();
    await postgres?.stop();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }, 30_000);

  it("migrates a clean database and safely re-runs migrations", async () => {
    await runMigrations(database, undefined, "esure_migrations");
    await runMigrations(database, undefined, "esure_migrations");
    const result = await database.query<{ count: string }>("SELECT count(*)::text AS count FROM schema_migrations");
    expect(result.rows[0]?.count).toBe("3");
  });

  it("detects a modified migration checksum", async () => {
    const migrationCopy = join(directory, "modified-migrations");
    await cp(resolve("migrations"), migrationCopy, { recursive: true });
    await appendFile(join(migrationCopy, "001_persistence_foundation.sql"), "\n-- modified\n");
    await expect(runMigrations(database, migrationCopy)).rejects.toThrow("checksum mismatch");
  });

  it("reconciles fixtures, treats identical content as a no-op, and versions changed content", async () => {
    const registry = createScenarioRegistry();
    const repository = new PublishedScenarioRepository(database);
    await repository.reconcile(registry);
    await repository.reconcile(registry);
    const scenarios = await repository.list();
    expect(scenarios.length).toBeGreaterThanOrEqual(10);
    expect((await repository.history("xlm-payment", 20)).items).toHaveLength(1);

    const original = registry.find("xlm-payment")!;
    const changed = prepareScenario({ ...withoutHash(original), description: `${original.description} changed` });
    await database.transaction((client) => reconcileFixture(client, changed));
    const history = await repository.history("xlm-payment", 20);
    expect(history.items.map((item) => item.version)).toEqual([2, 1]);
    expect((await repository.version("xlm-payment", 1))?.description).toBe(original.description);
    expect((await repository.version("xlm-payment", 2))?.description).toContain("changed");
  });

  it("serializes concurrent reconciliation without duplicate versions", async () => {
    const registry = createScenarioRegistry();
    const original = registry.find("issued-asset-payment")!;
    const changed = prepareScenario({ ...withoutHash(original), description: `${original.description} concurrent` });
    await Promise.all(Array.from({ length: 8 }, () => database.transaction((client) => reconcileFixture(client, changed))));
    const result = await database.query<{ count: string; maximum: number }>(`SELECT count(*)::text AS count, max(sv.version_number)::integer AS maximum
      FROM scenario_versions sv JOIN scenarios s ON s.id = sv.scenario_id WHERE s.public_slug = 'issued-asset-payment'`);
    expect(result.rows[0]).toMatchObject({ count: "2", maximum: 2 });
  });

  it("enforces inline identity isolation and foreign keys", async () => {
    await expect(database.query("INSERT INTO scenarios(public_slug, origin, visibility) VALUES ('xlm-payment', 'anonymous_inline', 'unlisted')")).rejects.toThrow();
    await expect(database.query("INSERT INTO scenarios(public_slug, origin, visibility) VALUES (NULL, 'anonymous_inline', 'published')")).rejects.toThrow();
    await expect(database.query("INSERT INTO scenario_versions(scenario_id, version_number, schema_version, content_hash, definition, source_format) VALUES (gen_random_uuid(), 1, 1, 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', '{}'::jsonb, 'json')")).rejects.toThrow();
  });

  it("denies immutable version UPDATE and DELETE to the application role and to the owner", async () => {
    const id = (await database.query<{ id: string }>("SELECT id FROM scenario_versions LIMIT 1")).rows[0]!.id;
    await expect(database.transaction(async (client) => {
      await client.query("SET LOCAL ROLE esure_application");
      await client.query("UPDATE scenario_versions SET version_number = version_number WHERE id = $1", [id]);
    })).rejects.toThrow();
    await expect(database.query("DELETE FROM scenario_versions WHERE id = $1", [id])).rejects.toThrow("immutable");
  });

  it("allows only audited, expired, unreferenced inline cleanup through the maintenance role", async () => {
    const inline = await database.query<{ id: string }>(`INSERT INTO scenarios(origin, submitted_scenario_id, visibility, created_at)
      VALUES ('anonymous_inline', 'xlm-payment', 'unlisted', clock_timestamp() - interval '31 days') RETURNING id`);
    const scenarioId = inline.rows[0]!.id;
    const version = await database.query<{ id: string }>(`INSERT INTO scenario_versions(scenario_id, version_number, schema_version, content_hash, definition, source_format, created_at)
      VALUES ($1, 1, 1, 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', '{}'::jsonb, 'json', clock_timestamp() - interval '31 days') RETURNING id`, [scenarioId]);
    const versionId = version.rows[0]!.id;
    await expect(database.transaction(async (client) => {
      await client.query("SET LOCAL ROLE esure_maintenance");
      await client.query("SET LOCAL esure.cleanup_mode = 'on'");
      await client.query("DELETE FROM scenario_versions WHERE id = $1", [versionId]);
    })).rejects.toThrow("immutable");

    await database.transaction(async (client) => {
      const cleanupId = "123e4567-e89b-42d3-a456-426614174000";
      await client.query("SET LOCAL ROLE esure_maintenance");
      await client.query("SET LOCAL esure.cleanup_mode = 'on'");
      await client.query("SELECT set_config('esure.cleanup_id', $1, true)", [cleanupId]);
      await client.query("INSERT INTO cleanup_audit(cleanup_id, action, target_table, target_id, reason) VALUES ($1, 'delete_scenario_version', 'scenario_versions', $2, 'retention test')", [cleanupId, versionId]);
      await client.query("DELETE FROM scenario_versions WHERE id = $1", [versionId]);
      await client.query("INSERT INTO cleanup_audit(cleanup_id, action, target_table, target_id, reason) VALUES ($1, 'delete_scenario', 'scenarios', $2, 'retention test')", [cleanupId, scenarioId]);
      await client.query("DELETE FROM scenarios WHERE id = $1", [scenarioId]);
    });
    expect((await database.query("SELECT 1 FROM scenarios WHERE id = $1", [scenarioId])).rowCount).toBe(0);
  });

  it("supports bounded catalogue history and canonical JSON/YAML exports", async () => {
    const repository = new PublishedScenarioRepository(database);
    const first = await repository.history("xlm-payment", 1);
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).toBe(2);
    const second = await repository.history("xlm-payment", 1, first.nextCursor);
    expect(second.items[0]?.version).toBe(1);
    expect(await repository.export("xlm-payment", 1, "json")).toContain('"network": "testnet"');
    expect(await repository.export("xlm-payment", 1, "yaml")).toContain("network: testnet");
  });

  it("serves the read-only catalogue, exact versions, history, and exports through the API", async () => {
    const app = buildApp({ config: databaseConfig(`postgresql://postgres:test-password@127.0.0.1:${port}/postgres`) });
    try {
      await app.ready();
      const items = (await app.inject({ method: "GET", url: "/api/v1/scenarios" })).json().items;
      expect(items.length).toBeGreaterThanOrEqual(10);
      expect((await app.inject({ method: "GET", url: "/api/v1/scenarios/xlm-payment/versions?limit=1" })).json().items).toHaveLength(1);
      expect((await app.inject({ method: "GET", url: "/api/v1/scenarios/xlm-payment/versions/1" })).json()).toMatchObject({ id: "xlm-payment", version: 1 });
      const exported = await app.inject({ method: "GET", url: "/api/v1/scenarios/xlm-payment/versions/1/export?format=yaml" });
      expect(exported.statusCode).toBe(200);
      expect(exported.headers["content-type"]).toContain("application/yaml");
      expect(exported.body).toContain("network: testnet");
      expect((await app.inject({ method: "PATCH", url: "/api/v1/scenarios/xlm-payment", payload: {} })).statusCode).toBe(404);
    } finally { await app.close(); }
  });

  it("stores no Stellar seeds, signed XDR, or raw error fields", async () => {
    const result = await database.query<{ definitions: string }>("SELECT string_agg(definition::text, '') AS definitions FROM scenario_versions");
    expect(result.rows[0]?.definitions).not.toMatch(/S[A-Z2-7]{55}/);
    const columns = await database.query<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_schema = 'public'");
    expect(columns.rows.map((row) => row.column_name)).not.toEqual(expect.arrayContaining(["secret_seed", "signed_xdr", "raw_error"]));
  });
});

function databaseConfig(databaseUrl: string): AppConfig {
  return {
    host: "127.0.0.1", port: 3001, logLevel: "silent", horizonUrl: "https://horizon-testnet.stellar.org", friendbotUrl: "https://friendbot.stellar.org",
    runTimeoutMs: 5_000, stepTimeoutMs: 1_000, maxConcurrentRuns: 2, maxStoredRuns: 100, runRetentionMs: 60_000,
    rateLimitMax: 100, runRateLimitMax: 50, rateLimitWindowMs: 60_000, bodyLimitBytes: 16_384,
    persistenceMode: "published", databaseUrl, databasePoolMax: 5, databaseConnectionTimeoutMs: 5_000, databaseQueryTimeoutMs: 5_000, databaseIdleTimeoutMs: 10_000,
    runPersistenceEnabled: false,
  };
}

function withoutHash(value: ReturnType<typeof prepareScenario>) {
  const { contentHash: _contentHash, ...definition } = value;
  return definition;
}
