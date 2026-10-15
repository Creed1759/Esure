import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import EmbeddedPostgres from "embedded-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RunReport } from "../src/domain.js";
import { Database, runMigrations } from "../src/database.js";
import type { AppConfig } from "../src/config.js";
import { PostgresRunStore } from "../src/run-store.js";
import { buildApp } from "../src/app.js";

const port = 55_433;
const postgresAvailable = process.platform !== "win32" || existsSync("C:/Windows/System32/VCRUNTIME140.dll") ||
  existsSync("node_modules/@embedded-postgres/windows-x64/native/bin/VCRUNTIME140.dll");

(postgresAvailable ? describe.sequential : describe.skip)("PostgresRunStore", () => {
  let postgres: EmbeddedPostgres;
  let database: Database;
  let directory: string;
  let store: PostgresRunStore;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "esure-run-history-"));
    postgres = new EmbeddedPostgres({ databaseDir: directory, user: "postgres", password: "test-password", port, persistent: true, onLog: () => undefined, onError: () => undefined });
    await postgres.initialise();
    await postgres.start();
    database = new Database(databaseConfig(`postgres://postgres:test-password@127.0.0.1:${port}/postgres`));
    const roles = await readFile(resolve("database/bootstrap-roles.sql"), "utf8");
    await database.query(roles);
    await runMigrations(database);
    store = new PostgresRunStore(database, 60_000);
  }, 60_000);

  afterAll(async () => {
    await database?.close();
    await postgres?.stop();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }, 30_000);

  it("persists, reloads, and updates API-compatible reports", async () => {
    const run = report();
    await store.create(run);
    expect(await store.get(run.id)).toEqual(run);
    expect(await new PostgresRunStore(database, 60_000).get(run.id)).toEqual(run);

    const updated = await store.update(run.id, {
      status: "passed",
      completedAt: new Date().toISOString(),
      steps: [{ id: "pay", type: "payment", status: "passed", message: "Confirmed." }],
      summary: { stepsPassed: 1, stepsFailed: 0, assertionsPassed: 0, assertionsFailed: 0 },
    });
    expect(updated).toMatchObject({ id: run.id, status: "passed", steps: [{ id: "pay", status: "passed" }] });
    expect(await store.get(run.id)).toEqual(updated);
  });

  it("redacts account keys and secret seeds before writing reports", async () => {
    const seed = `S${"A".repeat(55)}`;
    const accountKey = `G${"B".repeat(55)}`;
    const run = report({
      steps: [Object.assign(
        { id: "unsafe-step", type: "payment", status: "failed" as const, message: `seed=${seed} account=${accountKey}` },
        { secretSeed: seed, account_key: accountKey },
      )],
      assertions: [{
        type: "accountExists",
        status: "failed",
        expected: true,
        actual: { secretKey: seed, accountKey },
        message: `reported ${accountKey}`,
      }],
    });
    await store.create(run);

    const stored = await database.query<{ steps: string; assertions: string }>(
      "SELECT steps::text, assertions::text FROM runs WHERE run_id = $1",
      [run.id],
    );
    const serialized = `${stored.rows[0]?.steps}${stored.rows[0]?.assertions}`;
    expect(serialized).not.toContain(seed);
    expect(serialized).not.toContain(accountKey);
    expect((await store.get(run.id))?.steps[0]?.message).toContain("[REDACTED]");
  });

  it("hides completed runs after their retention period", async () => {
    const completedAt = new Date(Date.now() - 120_000).toISOString();
    const run = report({
      status: "passed",
      createdAt: new Date(Date.now() - 180_000).toISOString(),
      completedAt,
    });
    await store.create(run);
    expect(await store.get(run.id)).toBeUndefined();
  });

  it("serves persisted run history after rebuilding the API app", async () => {
    const app = buildApp({
      config: databaseConfig(`postgres://postgres:test-password@127.0.0.1:${port}/postgres`),
      ledger: { execute: async () => ({ steps: [], assertions: [] }) },
    });
    let runId: string;
    try {
      await app.ready();
      const created = await app.inject({ method: "POST", url: "/api/v1/runs", payload: { scenarioId: "xlm-payment" } });
      expect(created.statusCode).toBe(202);
      runId = created.json().id;
      let status = created.json().status;
      for (let attempt = 0; attempt < 20 && status !== "passed" && status !== "failed"; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        status = (await app.inject({ method: "GET", url: `/api/v1/runs/${runId!}` })).json().status;
      }
      expect(status).toBe("passed");
    } finally {
      await app.close();
    }

    const restartedApp = buildApp({
      config: databaseConfig(`postgres://postgres:test-password@127.0.0.1:${port}/postgres`),
      ledger: { execute: async () => ({ steps: [], assertions: [] }) },
    });
    try {
      await restartedApp.ready();
      const response = await restartedApp.inject({ method: "GET", url: `/api/v1/runs/${runId!}` });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ id: runId!, scenarioId: "xlm-payment" });
    } finally {
      await restartedApp.close();
    }
  });

  it("applies and reverses the run history migration", async () => {
    const down = await readFile(resolve("migrations/003_persistent_run_history.down.sql"), "utf8");
    await database.query(down);
    const columns = await database.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'runs' AND column_name = 'run_id'`);
    expect(columns.rowCount).toBe(0);
    await runMigrations(database);
    const restored = await database.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'runs' AND column_name = 'run_id'`);
    expect(restored.rowCount).toBe(1);
  });
});

function report(overrides: Partial<RunReport> = {}): RunReport {
  return {
    id: randomUUID(),
    scenarioId: "integration-scenario",
    scenarioVersion: 1,
    scenarioSchemaVersion: 1,
    scenarioContentHash: "sha256:integration",
    network: "testnet",
    status: "running",
    createdAt: new Date().toISOString(),
    steps: [],
    assertions: [],
    summary: { stepsPassed: 0, stepsFailed: 0, assertionsPassed: 0, assertionsFailed: 0 },
    ...overrides,
  };
}

function databaseConfig(databaseUrl: string): AppConfig {
  return {
    host: "127.0.0.1", port: 3001, logLevel: "silent", horizonUrl: "https://horizon-testnet.stellar.org", friendbotUrl: "https://friendbot.stellar.org",
    runTimeoutMs: 5_000, stepTimeoutMs: 1_000, maxConcurrentRuns: 2, maxStoredRuns: 100, runRetentionMs: 60_000,
    rateLimitMax: 100, runRateLimitMax: 50, rateLimitWindowMs: 60_000, bodyLimitBytes: 16_384,
    persistenceMode: "published", runPersistenceEnabled: true, databaseUrl, databasePoolMax: 5, databaseConnectionTimeoutMs: 5_000, databaseQueryTimeoutMs: 5_000, databaseIdleTimeoutMs: 10_000,
  };
}
