import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ValidatedScenario } from "@esure/backend/src/domain.js";

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  find: vi.fn(),
  list: vi.fn(),
  createRegistry: vi.fn(),
  readFile: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({ readFile: mocks.readFile }));
vi.mock("@esure/backend/src/scenarios.js", () => ({
  createScenarioRegistry: mocks.createRegistry,
}));
vi.mock("@esure/backend/src/stellar-gateway.js", () => ({
  StellarTestnetGateway: class {
    execute = mocks.execute;
  },
}));

const definition = {
  schemaVersion: 1,
  id: "test-scenario",
  version: 1,
  name: "Test scenario",
  description: "A scenario used by CLI tests",
  network: "testnet",
  accounts: [{ id: "alice", generate: true, fund: true }],
  assets: [{ id: "xlm", type: "native" }],
  steps: [],
  assertions: [{ type: "accountExists", account: "alice" }],
} satisfies Omit<ValidatedScenario, "contentHash">;

const scenario: ValidatedScenario = {
  ...definition,
  contentHash: "sha256:test",
};

const catalog = [{
  id: scenario.id,
  version: scenario.version,
  name: scenario.name,
  description: scenario.description,
}];

const validJson = JSON.stringify(definition);
const validYaml = [
  "schemaVersion: 1",
  "id: test-scenario",
  "version: 1",
  "name: Test scenario",
  "description: A scenario used by CLI tests",
  "network: testnet",
  "accounts:",
  "  - id: alice",
  "    generate: true",
  "    fund: true",
  "assets:",
  "  - id: xlm",
  "    type: native",
  "steps: []",
  "assertions:",
  "  - type: accountExists",
  "    account: alice",
].join("\n");

const passedExecution = {
  steps: [{ id: "step-1", type: "payment", status: "passed", message: "Payment confirmed." }],
  assertions: [{ type: "accountExists", status: "passed", expected: true, actual: true, message: "Account exists." }],
};

let stdout: string[];
let stderr: string[];
let originalArgv: string[];
let originalExitCode: number | undefined;

async function invokeCli(...args: string[]): Promise<number | undefined> {
  process.argv = ["node", "cli.ts", ...args];
  vi.resetModules();
  await import("../src/cli.js");
  await new Promise<void>((resolve) => setImmediate(resolve));
  return process.exitCode;
}

async function withFile(content: string, _filePath?: string): Promise<void> {
  mocks.readFile.mockResolvedValueOnce(content);
}

describe("CLI commands", () => {
  beforeEach(() => {
    stdout = [];
    stderr = [];
    originalArgv = process.argv;
    originalExitCode = process.exitCode;
    process.exitCode = undefined;
    vi.spyOn(console, "log").mockImplementation((...values: unknown[]) => {
      stdout.push(values.join(" "));
    });
    vi.spyOn(console, "error").mockImplementation((...values: unknown[]) => {
      stderr.push(values.join(" "));
    });

    mocks.list.mockReturnValue(catalog);
    mocks.find.mockImplementation((id: string) => id === scenario.id ? structuredClone(scenario) : undefined);
    mocks.createRegistry.mockReturnValue({ list: mocks.list, find: mocks.find });
    mocks.execute.mockResolvedValue(passedExecution);
    mocks.readFile.mockReset();
    mocks.list.mockClear();
    mocks.find.mockClear();
    mocks.createRegistry.mockClear();
    mocks.execute.mockClear();
  });

  afterEach(() => {
    process.argv = originalArgv;
    process.exitCode = originalExitCode;
    vi.restoreAllMocks();
  });

  it("lists scenarios in human-readable format", async () => {
    expect(await invokeCli("list")).toBe(0);
    expect(stdout.join("\n")).toContain("Bundled Scenarios (1)");
    expect(stdout.join("\n")).toContain("test-scenario");
    expect(stderr).toEqual([]);
  });

  it("lists scenarios as JSON", async () => {
    expect(await invokeCli("list", "--output", "json")).toBe(0);
    expect(JSON.parse(stdout.join("\n"))).toEqual({ scenarios: catalog });
  });

  it.each(["human", "json"])("reports registry errors in %s format", async (format) => {
    mocks.createRegistry.mockImplementation(() => {
      throw new Error("registry unavailable");
    });
    expect(await invokeCli("list", "--output", format)).toBe(1);
    if (format === "json") {
      expect(JSON.parse(stderr.join("\n"))).toEqual({ error: { message: "registry unavailable" } });
    } else {
      expect(stderr.join("\n")).toContain("registry unavailable");
    }
  });

  it.each([
    ["JSON", "scenario.json", validJson],
    ["YAML", "scenario.yaml", validYaml],
    ["YML", "scenario.yml", validYaml],
  ])("validates %s scenario files", async (_format, filePath, contents) => {
    await withFile(contents, filePath);
    expect(await invokeCli("validate", filePath)).toBe(0);
    expect(stdout.join("\n")).toContain("Scenario is valid");
    expect(stderr).toEqual([]);
  });

  it("returns validation details as JSON", async () => {
    await withFile(validJson);
    expect(await invokeCli("validate", "scenario.json", "--output", "json")).toBe(0);
    const result = JSON.parse(stdout.join("\n"));
    expect(result).toMatchObject({
      valid: true,
      scenarioId: scenario.id,
      version: scenario.version,
      schemaVersion: scenario.schemaVersion,
    });
  });

  it.each([
    ["invalid JSON", "{", "scenario.json"],
    ["invalid YAML", "schemaVersion: [", "scenario.yaml"],
    ["invalid schema", JSON.stringify({ ...scenario, extra: true }), "scenario.json"],
    ["Mainnet configuration", JSON.stringify({ ...scenario, network: "mainnet" }), "scenario.json"],
    ["secret seed", JSON.stringify({ ...scenario, name: `seed ${"S".repeat(56)}` }), "scenario.json"],
    ["unsupported extension", validJson, "scenario.txt"],
  ])("rejects %s and emits JSON error output", async (_label, contents, filePath) => {
    await withFile(contents, filePath);
    expect(await invokeCli("validate", filePath, "--output", "json")).toBe(1);
    const result = JSON.parse(stderr.join("\n"));
    expect(result.valid).toBe(false);
    expect(result.error.message).toBeTruthy();
  });

  it("prints validation issues in human-readable output", async () => {
    await withFile(JSON.stringify({ ...scenario, network: "mainnet" }));
    expect(await invokeCli("validate", "scenario.json")).toBe(1);
    expect(stderr.join("\n")).toContain("Validation failed");
    expect(stderr.join("\n")).toContain("network");
  });

  it("reports file read errors as JSON", async () => {
    mocks.readFile.mockRejectedValueOnce(new Error("file unavailable"));
    expect(await invokeCli("validate", "scenario.json", "--output", "json")).toBe(1);
    expect(JSON.parse(stderr.join("\n"))).toEqual({
      valid: false,
      error: { message: "file unavailable" },
    });
  });

  it("runs a bundled scenario and returns a passing JSON report", async () => {
    expect(await invokeCli("run", scenario.id, "--output", "json")).toBe(0);
    const result = JSON.parse(stdout.join("\n"));
    expect(result).toMatchObject({
      scenarioId: scenario.id,
      scenarioVersion: scenario.version,
      status: "passed",
      summary: { stepsPassed: 1, stepsFailed: 0, assertionsPassed: 1, assertionsFailed: 0 },
    });
    expect(mocks.execute).toHaveBeenCalledWith(expect.objectContaining({ id: scenario.id }), {
      stepTimeoutMs: 30000,
    });
  });

  it("runs a scenario file and prints a human-readable passing report", async () => {
    await withFile(validJson);
    expect(await invokeCli("run", "scenario.json")).toBe(0);
    expect(stdout.join("\n")).toContain("Running scenario: Test scenario");
    expect(stdout.join("\n")).toContain("Result: PASSED");
  });

  it("returns exit code 1 for failed steps or assertions", async () => {
    mocks.execute.mockResolvedValueOnce({
      steps: [{ id: "step-1", type: "payment", status: "failed", message: "Payment failed." }],
      assertions: [{ type: "accountExists", status: "failed", expected: true, actual: false, message: "Account missing." }],
    });
    expect(await invokeCli("run", scenario.id, "--output", "json")).toBe(1);
    expect(JSON.parse(stdout.join("\n"))).toMatchObject({
      status: "failed",
      summary: { stepsFailed: 1, assertionsFailed: 1 },
    });
  });

  it("reports execution errors as JSON and preserves attached reports", async () => {
    mocks.execute.mockRejectedValueOnce(Object.assign(new Error("gateway failed"), { report: { id: "run-1" } }));
    expect(await invokeCli("run", scenario.id, "--output", "json")).toBe(1);
    expect(JSON.parse(stderr.join("\n"))).toEqual({
      status: "error",
      error: { message: "gateway failed", report: { id: "run-1" } },
    });
  });

  it("reports unknown bundled scenarios", async () => {
    expect(await invokeCli("run", "missing-scenario", "--output", "json")).toBe(1);
    expect(JSON.parse(stderr.join("\n")).error.message).toContain("not found");
  });

  it("handles missing arguments, unknown commands, help, and version", async () => {
    expect(await invokeCli("validate")).toBe(1);
    expect(stderr.join("\n")).toContain("Missing file path argument");

    stderr = [];
    expect(await invokeCli("run")).toBe(1);
    expect(stderr.join("\n")).toContain("Missing scenario ID or file path");

    stderr = [];
    expect(await invokeCli("unknown")).toBe(1);
    expect(stderr.join("\n")).toContain('Unknown command "unknown"');

    stdout = [];
    expect(await invokeCli("list", "--help")).toBe(0);
    expect(stdout.join("\n")).toContain("Usage:");

    stdout = [];
    expect(await invokeCli("--help")).toBe(1);
    expect(stdout.join("\n")).toContain("Usage:");

    stdout = [];
    expect(await invokeCli("--version")).toBe(0);
    expect(stdout.join("\n")).toContain("esure v0.1.0");
  });
});
