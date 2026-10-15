import { randomUUID } from "node:crypto";
import type { LedgerGateway, RunError, RunReport, RunSummary, ValidatedScenario } from "./domain.js";
import type { RunStore } from "./run-store.js";
import { RunCapacityError, RunTimeoutError, SafeRunError, ShutdownError, withTimeout } from "./errors.js";

const emptySummary = (): RunSummary => ({
  stepsPassed: 0,
  stepsFailed: 0,
  assertionsPassed: 0,
  assertionsFailed: 0,
});

export class RunService {
  #activeRuns = 0;
  #draining = false;
  readonly #activePromises = new Set<Promise<void>>();

  constructor(
    private readonly store: RunStore,
    private readonly ledger: LedgerGateway,
    private readonly options: { maxConcurrentRuns: number; runTimeoutMs: number; stepTimeoutMs: number },
  ) {}

  /** True once drain() has been called; new starts are rejected after this point. */
  get draining(): boolean {
    return this.#draining;
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

  async start(scenario: ValidatedScenario): Promise<RunReport> {
    if (this.#draining) throw new RunCapacityError("The server is shutting down. No new runs are accepted.");
    if (this.#activeRuns >= this.options.maxConcurrentRuns) throw new RunCapacityError();
    const run: RunReport = {
      id: randomUUID(),
      scenarioId: scenario.id,
      scenarioVersion: scenario.version,
      scenarioSchemaVersion: scenario.schemaVersion,
      scenarioContentHash: scenario.contentHash,
      network: "testnet",
      status: "requested",
      createdAt: new Date().toISOString(),
      steps: [],
      assertions: [],
      summary: emptySummary(),
    };
    await this.store.create(run);
    this.#activeRuns += 1;
    const execution = new Promise<void>((resolve) => {
      setImmediate(() => void this.execute(run.id, scenario).then(resolve, resolve));
    });
    this.#activePromises.add(execution);
    execution.then(() => this.#activePromises.delete(execution), () => this.#activePromises.delete(execution));
    return run;
  }

  get(id: string): Promise<RunReport | undefined> {
    return Promise.resolve(this.store.get(id));
  }

  async execute(id: string, scenario: ValidatedScenario): Promise<void> {
    const controller = new AbortController();
    let progressUpdates = Promise.resolve();
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
      await this.store.update(id, {
        status: passed ? "passed" : "failed",
        completedAt: new Date().toISOString(),
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
    } catch (error) {
      await progressUpdates;
      const current = await this.store.get(id);
      const steps = current?.steps ?? [];
      const assertions = current?.assertions ?? [];
      await this.store.update(id, {
        status: "failed",
        completedAt: new Date().toISOString(),
        steps,
        assertions,
        summary: summarize(steps, assertions),
        error: normalizeError(error),
      });
    } finally {
      controller.abort();
      this.#activeRuns = Math.max(0, this.#activeRuns - 1);
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
