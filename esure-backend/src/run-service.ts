import { randomUUID } from "node:crypto";
import type { LedgerGateway, RunError, RunReport, RunSummary, ValidatedScenario } from "./domain.js";
import type { RunStore } from "./run-store.js";
import { RunCapacityError, RunDrainingError, RunTimeoutError, SafeRunError, ShutdownError, withTimeout } from "./errors.js";

const emptySummary = (): RunSummary => ({
  stepsPassed: 0,
  stepsFailed: 0,
  assertionsPassed: 0,
  assertionsFailed: 0,
});

const SAFE_RUN_ERROR_CODES = new Set([
  "ASSERTION_FAILED",
  "FRIENDBOT_UNAVAILABLE",
  "HORIZON_UNAVAILABLE",
  "INTERNAL_ERROR",
  "NETWORK_UNAVAILABLE",
  "RUNNER_AT_CAPACITY",
  "RUN_TIMEOUT",
  "SERVER_SHUTDOWN",
  "STEP_TIMEOUT",
  "STELLAR_TRANSACTION_FAILED",
]);

export interface RunMetricsSnapshot {
  activeRuns: number;
  terminalRuns: { passed: number; failed: number };
  rejectedStarts: { capacity: number; draining: number };
  runDuration: { count: number; totalMilliseconds: number };
}

export interface RunLifecycleLog {
  event: "run.started" | "run.completed" | "run.failed";
  runId: string;
  scenarioId: string;
  scenarioVersion: number;
  requestId?: string;
  status: RunReport["status"];
  durationMs: number;
  errorCode?: string;
}

export interface RunLifecycleLogger {
  info(fields: RunLifecycleLog): void;
}

export class RunService {
  #activeRuns = 0;
  #draining = false;
  readonly #activePromises = new Set<Promise<void>>();
  #passedRuns = 0;
  #failedRuns = 0;
  #capacityRejectedStarts = 0;
  #drainingRejectedStarts = 0;
  #runDurationCount = 0;
  #runDurationTotalMilliseconds = 0;

  constructor(
    private readonly store: RunStore,
    private readonly ledger: LedgerGateway,
    private readonly options: { maxConcurrentRuns: number; runTimeoutMs: number; stepTimeoutMs: number },
    private readonly now: () => number = Date.now,
    private readonly logger?: RunLifecycleLogger,
  ) {}

  /** True once drain() has been called; new starts are rejected after this point. */
  get draining(): boolean {
    return this.#draining;
  }

  getMetrics(): RunMetricsSnapshot {
    return {
      activeRuns: this.#activeRuns,
      terminalRuns: { passed: this.#passedRuns, failed: this.#failedRuns },
      rejectedStarts: { capacity: this.#capacityRejectedStarts, draining: this.#drainingRejectedStarts },
      runDuration: { count: this.#runDurationCount, totalMilliseconds: this.#runDurationTotalMilliseconds },
    };
  }

  /**
   * Signal that no new runs should be accepted, then wait for all active
   * executions to finish or be cancelled.  The caller controls the outer
   * deadline — call with a wrapping Promise.race / setTimeout as needed.
   */
  async drain(): Promise<void> {
    this.#draining = true;
    if (this.#activePromises.size > 0) {
      await Promise.allSettled([...this.#activePromises]);
    }
  }

  async start(scenario: ValidatedScenario, requestId?: string): Promise<RunReport> {
    if (this.#draining) {
      this.#drainingRejectedStarts += 1;
      throw new RunDrainingError();
    }
    if (this.#activeRuns >= this.options.maxConcurrentRuns) {
      this.#capacityRejectedStarts += 1;
      throw new RunCapacityError();
    }
    this.#activeRuns += 1;
    let resolveExecution!: () => void;
    const execution = new Promise<void>((resolve) => {
      resolveExecution = resolve;
    });
    this.#activePromises.add(execution);
    execution.then(() => this.#activePromises.delete(execution));
    const run: RunReport = {
      id: randomUUID(),
      scenarioId: scenario.id,
      scenarioVersion: scenario.version,
      scenarioSchemaVersion: scenario.schemaVersion,
      scenarioContentHash: scenario.contentHash,
      network: "testnet",
      status: "requested",
      createdAt: new Date(this.now()).toISOString(),
      steps: [],
      assertions: [],
      summary: emptySummary(),
    };
    try {
      await this.store.create(run);
    } catch (error) {
      this.#activeRuns -= 1;
      if (error instanceof RunCapacityError) this.#capacityRejectedStarts += 1;
      resolveExecution();
      throw error;
    }
    const startedAt = this.now();
    this.logger?.info({
      event: "run.started",
      runId: run.id,
      scenarioId: scenario.id,
      scenarioVersion: scenario.version,
      ...(requestId !== undefined && { requestId }),
      status: run.status,
      durationMs: 0,
    });
    setImmediate(() => void this.execute(run.id, scenario, startedAt, requestId).then(resolveExecution, resolveExecution));
    return run;
  }

  get(id: string): Promise<RunReport | undefined> {
    return Promise.resolve(this.store.get(id));
  }

  async execute(id: string, scenario: ValidatedScenario, startedAt = this.now(), requestId?: string): Promise<void> {
    const controller = new AbortController();
    let progressUpdates = Promise.resolve();
    let outcome: "passed" | "failed" = "failed";
    let errorCode: string | undefined;
    try {
      await this.store.update(id, { status: "validating" });
      // If drain() was called between start() and this point, abort immediately.
      if (this.#draining) controller.abort();
      await this.store.update(id, { status: "running" });
      const execution = this.ledger.execute(scenario, {
        signal: controller.signal,
        stepTimeoutMs: this.options.stepTimeoutMs,
        onStep: (step) => {
          progressUpdates = progressUpdates.then(async () => {
            const current = await this.store.get(id);
            if (!current || current.status === "passed" || current.status === "failed") return;
            const steps = [...current.steps, step];
            await this.store.update(id, { steps, summary: summarize(steps, current.assertions) });
          });
        },
        onAssertion: (assertion) => {
          progressUpdates = progressUpdates.then(async () => {
            const current = await this.store.get(id);
            if (!current || current.status === "passed" || current.status === "failed") return;
            const assertions = [...current.assertions, assertion];
            await this.store.update(id, { assertions, summary: summarize(current.steps, assertions) });
          });
        },
      });
      execution.catch(() => {});
      const result = await withTimeout(
        execution,
        this.options.runTimeoutMs,
        () => new RunTimeoutError(this.options.runTimeoutMs),
        () => controller.abort(),
      );
      await progressUpdates;
      const summary = summarize(result.steps, result.assertions);
      const passed = summary.stepsFailed === 0 && summary.assertionsFailed === 0;
      errorCode = passed ? undefined : "ASSERTION_FAILED";
      await this.store.update(id, {
        status: passed ? "passed" : "failed",
        completedAt: new Date(this.now()).toISOString(),
        steps: result.steps,
        assertions: result.assertions,
        summary,
        ...(!passed && {
          error: {
            code: "ASSERTION_FAILED",
            message: "One or more checks failed.",
            category: "stellar" as const,
            retryable: false,
          },
        }),
      });
      outcome = passed ? "passed" : "failed";
    } catch (error) {
      await progressUpdates;
      const current = await this.store.get(id);
      const steps = current?.steps ?? [];
      const assertions = current?.assertions ?? [];
      const normalizedError = normalizeError(error);
      errorCode = SAFE_RUN_ERROR_CODES.has(normalizedError.code) ? normalizedError.code : "INTERNAL_ERROR";
      await this.store.update(id, {
        status: "failed",
        completedAt: new Date(this.now()).toISOString(),
        steps,
        assertions,
        summary: summarize(steps, assertions),
        error: normalizedError,
      });
    } finally {
      controller.abort();
      this.#activeRuns -= 1;
      if (outcome === "passed") this.#passedRuns += 1;
      else this.#failedRuns += 1;
      const durationMs = Math.max(0, this.now() - startedAt);
      this.#runDurationCount += 1;
      this.#runDurationTotalMilliseconds += durationMs;
      this.logger?.info({
        event: outcome === "passed" ? "run.completed" : "run.failed",
        runId: id,
        scenarioId: scenario.id,
        scenarioVersion: scenario.version,
        ...(requestId !== undefined && { requestId }),
        status: outcome,
        durationMs,
        ...(errorCode !== undefined && { errorCode }),
      });
    }
  }
}

function summarize(steps: RunReport["steps"], assertions: RunReport["assertions"]): RunSummary {
  return {
    stepsPassed: steps.filter((step) => step.status === "passed").length,
    stepsFailed: steps.filter((step) => step.status === "failed").length,
    assertionsPassed: assertions.filter((item) => item.status === "passed").length,
    assertionsFailed: assertions.filter((item) => item.status === "failed").length,
  };
}

function normalizeError(error: unknown): RunError {
  if (error instanceof SafeRunError) return structuredClone(error.report);
  return {
    code: "INTERNAL_ERROR",
    message: "The scenario run failed unexpectedly. Sensitive internal details were removed.",
    category: "internal",
    retryable: false,
  };
}
