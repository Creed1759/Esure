#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { validateScenarioDefinition } from "@esure/backend/src/scenario-schema.js";
import { prepareScenario } from "@esure/backend/src/scenario-loader.js";
import { createScenarioRegistry } from "@esure/backend/src/scenarios.js";
import { StellarTestnetGateway } from "@esure/backend/src/stellar-gateway.js";
import { parse as parseYaml } from "yaml";
import type { ValidatedScenario } from "@esure/backend/src/domain.js";
import type { LedgerExecution, LedgerExecutionOptions } from "@esure/backend/src/domain.js";

const VERSION = "0.1.0";
const BUNDLED_SCENARIO_DIR_TIMEOUT_MS = 30_000;

// ─────────────────────────────────────────────────────────────────────────────
// Shared types
// ─────────────────────────────────────────────────────────────────────────────

interface CliOptions {
  output?: "human" | "json";
  help?: boolean;
  version?: boolean;
  /** #68 — use ASCII status markers (PASS/FAIL) instead of Unicode glyphs */
  ascii?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Status markers (#68)
// ─────────────────────────────────────────────────────────────────────────────

interface Markers {
  pass: string;
  fail: string;
}

function markers(ascii: boolean): Markers {
  return ascii ? { pass: "PASS", fail: "FAIL" } : { pass: "✓", fail: "✗" };
}

function statusMarker(status: "passed" | "failed" | string, m: Markers): string {
  return status === "passed" ? m.pass : m.fail;
}

// ─────────────────────────────────────────────────────────────────────────────
// Help & version
// ─────────────────────────────────────────────────────────────────────────────

function showHelp(): void {
  console.log(`
esure - Stellar Testnet scenario testing toolkit

Usage:
  esure list                              List bundled scenarios
  esure validate <file>                   Validate a scenario file
  esure run <scenario-id>                 Run a bundled scenario
  esure run <file>                        Run a scenario from file
  esure run-suite <id> [<id>...]          Run multiple bundled scenarios sequentially

Options:
  --output <format>   Output format: human (default) or json
  --ascii             Use ASCII status markers (PASS/FAIL) instead of Unicode glyphs
  --fail-fast         (run-suite) Stop after first failure
  --help              Show this help message
  --version           Show version information

Examples:
  esure list
  esure validate ./my-scenario.yaml
  esure run xlm-payment
  esure run ./my-scenario.yaml --output json
  esure run-suite xlm-payment path-payment --fail-fast

Documentation: https://github.com/Esureorg/Esure
`);
}

function showVersion(): void {
  console.log(`esure v${VERSION}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Argument parsing
// ─────────────────────────────────────────────────────────────────────────────

function parseCliArgs(): {
  command?: string;
  args: string[];
  options: CliOptions;
  failFast: boolean;
} {
  const { values, positionals } = parseArgs({
    options: {
      output: { type: "string" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
      ascii: { type: "boolean" },
      "fail-fast": { type: "boolean" },
    },
    allowPositionals: true,
    strict: false,
  });

  return {
    command: positionals[0],
    args: positionals.slice(1),
    options: {
      output: values.output === "json" ? "json" : "human",
      help: Boolean(values.help),
      version: Boolean(values.version),
      ascii: Boolean(values.ascii),
    },
    failFast: Boolean(values["fail-fast"]),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Scenario loading
// ─────────────────────────────────────────────────────────────────────────────

async function loadScenarioFile(filePath: string): Promise<ValidatedScenario> {
  const absolutePath = resolve(filePath);
  const content = await readFile(absolutePath, "utf-8");

  let parsed: unknown;
  if (filePath.endsWith(".json")) {
    parsed = JSON.parse(content);
  } else if (filePath.endsWith(".yaml") || filePath.endsWith(".yml")) {
    parsed = parseYaml(content);
  } else {
    throw new Error("Scenario file must be .json, .yaml, or .yml");
  }

  const validated = validateScenarioDefinition(parsed);
  return prepareScenario(validated);
}

// ─────────────────────────────────────────────────────────────────────────────
// Execution helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Build a LedgerExecutionOptions object that prints progress in human mode (#66). */
function buildExecutionOptions(options: CliOptions): LedgerExecutionOptions {
  const execOptions: LedgerExecutionOptions = { stepTimeoutMs: BUNDLED_SCENARIO_DIR_TIMEOUT_MS };
  if (options.output === "human") {
    const m = markers(options.ascii ?? false);
    execOptions.onStep = (step) => {
      console.log(`  ${statusMarker(step.status, m)} step  ${step.id}: ${step.message}`);
    };
    execOptions.onAssertion = (assertion) => {
      console.log(`  ${statusMarker(assertion.status, m)} check ${assertion.type}: ${assertion.message}`);
    };
  }
  return execOptions;
}

function buildRunReport(
  scenario: ValidatedScenario,
  execution: LedgerExecution,
): {
  scenarioId: string;
  scenarioVersion: number;
  status: "passed" | "failed";
  steps: LedgerExecution["steps"];
  assertions: LedgerExecution["assertions"];
  summary: {
    stepsPassed: number;
    stepsFailed: number;
    assertionsPassed: number;
    assertionsFailed: number;
  };
} {
  const passed =
    execution.steps.every((s) => s.status === "passed") &&
    execution.assertions.every((a) => a.status === "passed");
  const stepsPassed = execution.steps.filter((s) => s.status === "passed").length;
  const assertionsPassed = execution.assertions.filter((a) => a.status === "passed").length;
  return {
    scenarioId: scenario.id,
    scenarioVersion: scenario.version,
    status: passed ? "passed" : "failed",
    steps: execution.steps,
    assertions: execution.assertions,
    summary: {
      stepsPassed,
      stepsFailed: execution.steps.length - stepsPassed,
      assertionsPassed,
      assertionsFailed: execution.assertions.length - assertionsPassed,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Commands
// ─────────────────────────────────────────────────────────────────────────────

async function listCommand(options: CliOptions): Promise<number> {
  try {
    const registry = createScenarioRegistry();
    const scenarios = registry.list();

    if (options.output === "json") {
      console.log(
        JSON.stringify(
          {
            scenarios: scenarios.map((s) => ({
              id: s.id,
              version: s.version,
              name: s.name,
              description: s.description,
            })),
          },
          null,
          2,
        ),
      );
    } else {
      console.log(`\nBundled Scenarios (${scenarios.length}):\n`);
      for (const scenario of scenarios) {
        console.log(`  ${scenario.id}`);
        console.log(`    ${scenario.name}`);
        console.log(`    ${scenario.description}\n`);
      }
    }
    return 0;
  } catch (error) {
    if (options.output === "json") {
      console.error(
        JSON.stringify({ error: { message: error instanceof Error ? error.message : String(error) } }),
      );
    } else {
      console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    }
    return 1;
  }
}

async function validateCommand(filePath: string, options: CliOptions): Promise<number> {
  try {
    const scenario = await loadScenarioFile(filePath);

    if (options.output === "json") {
      console.log(
        JSON.stringify(
          {
            valid: true,
            scenarioId: scenario.id,
            version: scenario.version,
            schemaVersion: scenario.schemaVersion,
            contentHash: scenario.contentHash,
          },
          null,
          2,
        ),
      );
    } else {
      const m = markers(options.ascii ?? false);
      console.log(`${m.pass} Scenario is valid`);
      console.log(`  ID: ${scenario.id}`);
      console.log(`  Version: ${scenario.version}`);
      console.log(`  Name: ${scenario.name}`);
      console.log(`  Schema: v${scenario.schemaVersion}`);
      console.log(`  Hash: ${scenario.contentHash}`);
    }
    return 0;
  } catch (error) {
    if (options.output === "json") {
      const errorObj: { message: string; issues?: string[] } = {
        message: error instanceof Error ? error.message : String(error),
      };
      if (error && typeof error === "object" && "issues" in error && Array.isArray(error.issues)) {
        errorObj.issues = error.issues as string[];
      }
      console.error(JSON.stringify({ valid: false, error: errorObj }, null, 2));
    } else {
      const m = markers(options.ascii ?? false);
      console.error(
        `${m.fail} Validation failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      if (error && typeof error === "object" && "issues" in error && Array.isArray(error.issues)) {
        for (const issue of error.issues) {
          console.error(`  - ${issue}`);
        }
      }
    }
    return 1;
  }
}

async function runCommand(target: string, options: CliOptions): Promise<number> {
  try {
    let scenario: ValidatedScenario;

    // Determine if target is a bundled scenario ID or file path
    if (target.includes("/") || target.includes("\\") || target.includes(".")) {
      scenario = await loadScenarioFile(target);
    } else {
      const registry = createScenarioRegistry();
      const found = registry.find(target);
      if (!found) {
        throw new Error(
          `Bundled scenario "${target}" not found. Run "esure list" to see available scenarios.`,
        );
      }
      scenario = found;
    }

    // Execute scenario on Stellar Testnet
    const gateway = new StellarTestnetGateway(
      "https://horizon-testnet.stellar.org",
      "https://friendbot.stellar.org",
    );

    if (options.output === "human") {
      console.log(`Running scenario: ${scenario.name}`);
      console.log(`ID: ${scenario.id} (v${scenario.version})\n`);
    }

    // #66 — attach onStep / onAssertion for real-time progress in human mode
    const execOptions = buildExecutionOptions(options);
    const execution = await gateway.execute(scenario, execOptions);
    const report = buildRunReport(scenario, execution);

    if (options.output === "json") {
      console.log(JSON.stringify(report, null, 2));
    } else {
      // In human mode the steps/assertions were already printed via callbacks.
      // Only print the final summary — do not reprint the full step list.
      const m = markers(options.ascii ?? false);
      const passed = report.status === "passed";
      console.log(`\nResult: ${passed ? "PASSED" : "FAILED"}`);
      console.log(
        `  Steps: ${report.summary.stepsPassed}/${execution.steps.length} passed`,
      );
      console.log(
        `  Assertions: ${report.summary.assertionsPassed}/${execution.assertions.length} passed`,
      );
      if (!passed) {
        console.log(`\n${m.fail} One or more checks failed.`);
      }
    }

    return report.status === "passed" ? 0 : 1;
  } catch (error) {
    if (options.output === "json") {
      const errorObj: { message: string; report?: unknown } = {
        message: error instanceof Error ? error.message : String(error),
      };
      if (error && typeof error === "object" && "report" in error) {
        errorObj.report = (error as { report: unknown }).report;
      }
      console.error(JSON.stringify({ status: "error", error: errorObj }, null, 2));
    } else {
      const m = markers(options.ascii ?? false);
      console.error(
        `\n${m.fail} Run failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return 1;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// #67 — run-suite command
// ─────────────────────────────────────────────────────────────────────────────

interface SuiteScenarioResult {
  scenarioId: string;
  status: "passed" | "failed" | "error";
  summary?: {
    stepsPassed: number;
    stepsFailed: number;
    assertionsPassed: number;
    assertionsFailed: number;
  };
  error?: { message: string };
}

async function runSuiteCommand(
  ids: string[],
  options: CliOptions,
  failFast: boolean,
): Promise<number> {
  // 1. Validate all IDs before any network work
  let registry: ReturnType<typeof createScenarioRegistry>;
  try {
    registry = createScenarioRegistry();
  } catch (error) {
    if (options.output === "json") {
      console.error(
        JSON.stringify({ error: { message: error instanceof Error ? error.message : String(error) } }),
      );
    } else {
      console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    }
    return 1;
  }

  // Check for duplicate IDs
  const seen = new Set<string>();
  const duplicates: string[] = [];
  for (const id of ids) {
    if (seen.has(id)) duplicates.push(id);
    seen.add(id);
  }
  if (duplicates.length > 0) {
    const msg = `Duplicate scenario IDs: ${duplicates.join(", ")}`;
    if (options.output === "json") {
      console.error(JSON.stringify({ error: { message: msg } }));
    } else {
      console.error(`Error: ${msg}`);
    }
    return 1;
  }

  // Check all IDs exist
  const invalid: string[] = [];
  const scenarios: ValidatedScenario[] = [];
  for (const id of ids) {
    const scenario = registry.find(id);
    if (!scenario) {
      invalid.push(id);
    } else {
      scenarios.push(scenario);
    }
  }
  if (invalid.length > 0) {
    const msg = `Unknown bundled scenario IDs: ${invalid.join(", ")}. Run "esure list" to see available scenarios.`;
    if (options.output === "json") {
      console.error(JSON.stringify({ error: { message: msg } }));
    } else {
      console.error(`Error: ${msg}`);
    }
    return 1;
  }

  // 2. Execute sequentially with isolated gateway per scenario
  const results: SuiteScenarioResult[] = [];
  let suitePassed = true;

  if (options.output === "human") {
    console.log(`\nRun suite: ${ids.length} scenario(s)\n`);
  }

  for (const scenario of scenarios) {
    if (options.output === "human") {
      console.log(`Running: ${scenario.id} — ${scenario.name}`);
    }

    let result: SuiteScenarioResult;
    try {
      const gateway = new StellarTestnetGateway(
        "https://horizon-testnet.stellar.org",
        "https://friendbot.stellar.org",
      );
      // Per-scenario isolated execution with progress callbacks in human mode
      const execOptions = buildExecutionOptions(options);
      const execution = await gateway.execute(scenario, execOptions);
      const report = buildRunReport(scenario, execution);
      result = {
        scenarioId: scenario.id,
        status: report.status,
        summary: report.summary,
      };
    } catch (error) {
      result = {
        scenarioId: scenario.id,
        status: "error",
        error: { message: error instanceof Error ? error.message : String(error) },
      };
    }

    results.push(result);
    if (result.status !== "passed") suitePassed = false;

    if (options.output === "human") {
      const m = markers(options.ascii ?? false);
      const marker = result.status === "passed" ? m.pass : m.fail;
      if (result.status === "error") {
        console.log(`  ${marker} ${scenario.id}: error — ${result.error?.message ?? "unknown"}\n`);
      } else {
        const s = result.summary!;
        console.log(
          `  ${marker} ${scenario.id}: ${result.status} (steps ${s.stepsPassed}/${s.stepsPassed + s.stepsFailed}, checks ${s.assertionsPassed}/${s.assertionsPassed + s.assertionsFailed})\n`,
        );
      }
    }

    if (!suitePassed && failFast) break;
  }

  // 3. Output final summary
  const passedCount = results.filter((r) => r.status === "passed").length;
  const failedCount = results.length - passedCount;

  if (options.output === "json") {
    console.log(
      JSON.stringify(
        {
          status: suitePassed ? "passed" : "failed",
          total: results.length,
          passed: passedCount,
          failed: failedCount,
          scenarios: results,
        },
        null,
        2,
      ),
    );
  } else {
    console.log(`Suite result: ${suitePassed ? "PASSED" : "FAILED"}`);
    console.log(`  ${passedCount}/${results.length} scenarios passed`);
    if (failFast && !suitePassed && results.length < ids.length) {
      console.log(
        `  Stopped early (--fail-fast). ${ids.length - results.length} scenario(s) not run.`,
      );
    }
  }

  return suitePassed ? 0 : 1;
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  const { command, args, options, failFast } = parseCliArgs();

  if (options.version) {
    showVersion();
    return 0;
  }

  if (options.help || !command) {
    showHelp();
    return command ? 0 : 1;
  }

  switch (command) {
    case "list":
      return listCommand(options);
    case "validate":
      if (args.length === 0) {
        console.error("Error: Missing file path argument");
        console.error("Usage: esure validate <file>");
        return 1;
      }
      return validateCommand(args[0], options);
    case "run":
      if (args.length === 0) {
        console.error("Error: Missing scenario ID or file path");
        console.error("Usage: esure run <scenario-id> or esure run <file>");
        return 1;
      }
      return runCommand(args[0], options);
    case "run-suite":
      if (args.length === 0) {
        console.error("Error: Missing scenario IDs");
        console.error("Usage: esure run-suite <id> [<id>...]");
        return 1;
      }
      return runSuiteCommand(args, options, failFast);
    default:
      console.error(`Error: Unknown command "${command}"`);
      console.error('Run "esure --help" for usage information');
      return 1;
  }
}

main()
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch((error) => {
    console.error("Fatal error:", error);
    process.exitCode = 1;
  });
