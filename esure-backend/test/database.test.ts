import { describe, expect, it } from "vitest";
import { Database, DatabaseUnavailableError } from "../src/database.js";
import type { AppConfig } from "../src/config.js";

describe("database outage handling", () => {
  it("classifies connection failures without exposing driver details", async () => {
    const database = new Database(config());
    try {
      await expect(database.readiness()).rejects.toBeInstanceOf(DatabaseUnavailableError);
      await expect(database.readiness()).rejects.toMatchObject({ message: "Database operation unavailable" });
    } finally { await database.close(); }
  });
});

function config(): AppConfig {
  return {
    host: "127.0.0.1", port: 3001, logLevel: "silent", horizonUrl: "https://horizon-testnet.stellar.org", friendbotUrl: "https://friendbot.stellar.org",
    runTimeoutMs: 5_000, stepTimeoutMs: 1_000, maxConcurrentRuns: 2, maxStoredRuns: 100, runRetentionMs: 60_000,
    runPersistenceEnabled: false,
    rateLimitMax: 100, runRateLimitMax: 50, rateLimitWindowMs: 60_000, bodyLimitBytes: 16_384,
    persistenceMode: "published", databaseUrl: "postgresql://invalid:invalid@127.0.0.1:1/esure",
    databasePoolMax: 1, databaseConnectionTimeoutMs: 500, databaseQueryTimeoutMs: 500, databaseIdleTimeoutMs: 1_000,
  };
}
