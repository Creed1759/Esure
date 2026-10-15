import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("uses safe Testnet defaults", () => {
    const config = loadConfig({});
    expect(config.horizonUrl).toContain("testnet");
    expect(config.friendbotUrl).toBe("https://friendbot.stellar.org");
  });

  it("rejects Mainnet configuration", () => {
    expect(() => loadConfig({ STELLAR_HORIZON_URL: "https://horizon.stellar.org" })).toThrow(/Testnet/);
  });

  it("rejects unsafe resource-limit configuration", () => {
    expect(() => loadConfig({ MAX_CONCURRENT_RUNS: "0" })).toThrow(/MAX_CONCURRENT_RUNS/);
    expect(() => loadConfig({ BODY_LIMIT_BYTES: "99999999" })).toThrow(/BODY_LIMIT_BYTES/);
  });

  it("keeps persistence explicitly disabled unless configured", () => {
    expect(loadConfig({}).persistenceMode).toBe("disabled");
    expect(loadConfig({}).runPersistenceEnabled).toBe(false);
    expect(() => loadConfig({ PERSISTENCE_MODE: "published" })).toThrow(/DATABASE_URL/);
    expect(() => loadConfig({ PERSISTENCE_MODE: "automatic" })).toThrow(/PERSISTENCE_MODE/);
  });

  it("requires published PostgreSQL persistence to enable run history", () => {
    expect(loadConfig({
      PERSISTENCE_MODE: "published",
      DATABASE_URL: "postgres://localhost/esure",
      RUN_PERSISTENCE_ENABLED: "true",
    }).runPersistenceEnabled).toBe(true);
    expect(() => loadConfig({ RUN_PERSISTENCE_ENABLED: "true" })).toThrow(/PERSISTENCE_MODE=published/);
    expect(() => loadConfig({
      PERSISTENCE_MODE: "published",
      DATABASE_URL: "postgres://localhost/esure",
      RUN_PERSISTENCE_ENABLED: "yes",
    })).toThrow(/RUN_PERSISTENCE_ENABLED/);
  });
});
