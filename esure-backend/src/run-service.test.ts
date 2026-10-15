import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { RunService } from "./run-service.js";
import { InMemoryRunStore } from "./run-store.js";
import type { LedgerGateway, ValidatedScenario, StepResult, AssertionResult, LedgerExecutionOptions } from "./domain.js";
import { RunTimeoutError } from "./errors.js";

const dummyScenario: ValidatedScenario = {
  id: "test-scenario",
  version: 1,
  schemaVersion: 1,
  name: "Test",
  description: "Test scenario",
  network: "testnet",
  contentHash: "hash",
  accounts: [],
  assets: [],
  steps: [],
  assertions: [],
};

const dummyStep: StepResult = {
  id: "step-1",
  type: "payment",
  status: "passed",
  message: "Done",
};

const dummyAssertion: AssertionResult = {
  type: "accountExists",
  status: "passed",
  expected: true,
  actual: true,
  message: "Yes",
};

describe("RunService", () => {
  let store: InMemoryRunStore;
  
  beforeEach(() => {
    vi.useFakeTimers();
    store = new InMemoryRunStore();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("handles normal success", async () => {
    const gateway: LedgerGateway = {
      async execute(scenario, options) {
        options?.onStep?.(dummyStep);
        options?.onAssertion?.(dummyAssertion);
        return { steps: [dummyStep], assertions: [dummyAssertion] };
      }
    };
    
    const service = new RunService(store, gateway, { maxConcurrentRuns: 1, runTimeoutMs: 1000, stepTimeoutMs: 500 });
    const run = await service.start(dummyScenario);
    expect(run.status).toBe("requested");
    
    // allow event loop to run async execute
    await vi.runAllTimersAsync();
    
    const finalized = store.get(run.id);
    expect(finalized?.status).toBe("passed");
    expect(finalized?.summary.stepsPassed).toBe(1);
    expect(finalized?.summary.assertionsPassed).toBe(1);
  });

  it("handles timeout, retains progress, and ignores late callbacks and settlement", async () => {
    let capturedOptions: LedgerExecutionOptions | undefined;
    let resolveExecution!: (val: any) => void;
    let rejectExecution!: (err: any) => void;

    const gateway: LedgerGateway = {
      execute(scenario, options) {
        capturedOptions = options;
        return new Promise((resolve, reject) => {
          resolveExecution = resolve;
          rejectExecution = reject;
        });
      }
    };

    const service = new RunService(store, gateway, { maxConcurrentRuns: 1, runTimeoutMs: 1000, stepTimeoutMs: 500 });
    const run = await service.start(dummyScenario);
    
    // Run immediate tasks to enter execute()
    await vi.advanceTimersByTimeAsync(0);

    // Fire progress BEFORE timeout
    expect(capturedOptions).toBeDefined();
    capturedOptions?.onStep?.({ ...dummyStep, id: "early-step" });
    
    // Advance time to trigger timeout
    await vi.advanceTimersByTimeAsync(1500);

    const timedOut = store.get(run.id);
    expect(timedOut?.status).toBe("failed");
    expect(timedOut?.error?.code).toBe("RUN_TIMEOUT");
    expect(timedOut?.steps).toHaveLength(1);
    expect(timedOut?.summary.stepsPassed).toBe(1); // from early step
    
    const completedAt = timedOut?.completedAt;

    // Fire late progress callbacks AFTER timeout
    capturedOptions?.onStep?.({ ...dummyStep, id: "late-step" });
    capturedOptions?.onAssertion?.(dummyAssertion);

    const afterLateProgress = store.get(run.id);
    expect(afterLateProgress?.steps).toHaveLength(1); // late step ignored
    expect(afterLateProgress?.assertions).toHaveLength(0); // late assertion ignored
    expect(afterLateProgress?.completedAt).toBe(completedAt); // unmodified

    // Fire late settlement (resolve)
    resolveExecution({ steps: [dummyStep, dummyStep], assertions: [dummyAssertion] });
    await Promise.resolve(); // wait for execution catch block to tick

    const afterLateResolve = store.get(run.id);
    expect(afterLateResolve?.steps).toHaveLength(1); // still unmodified
    
    // Fire late settlement (reject) on a new run
    const run2 = await service.start(dummyScenario);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1500);
    rejectExecution(new Error("Late error"));
    await Promise.resolve(); // Should not crash or unhandled rejection
    
    const run2Failed = store.get(run2.id);
    expect(run2Failed?.status).toBe("failed");
    expect(run2Failed?.error?.code).toBe("RUN_TIMEOUT");
  });

  it("ignores late callbacks after report eviction", async () => {
    let capturedOptions: LedgerExecutionOptions | undefined;
    const gateway: LedgerGateway = {
      execute(scenario, options) {
        capturedOptions = options;
        return new Promise(() => {}); // never resolves
      }
    };

    const retentionMs = 1000;
    store = new InMemoryRunStore(500, retentionMs);
    const service = new RunService(store, gateway, { maxConcurrentRuns: 1, runTimeoutMs: 1000, stepTimeoutMs: 500 });
    
    const run = await service.start(dummyScenario);
    await Promise.resolve();
    
    // trigger timeout
    await vi.advanceTimersByTimeAsync(1500);
    expect(store.get(run.id)?.status).toBe("failed");

    // advance time to evict run
    await vi.advanceTimersByTimeAsync(retentionMs + 1000);
    expect(store.get(run.id)).toBeUndefined(); // evicted

    // Late callbacks should not throw or recreate run
    expect(() => {
      capturedOptions?.onStep?.(dummyStep);
      capturedOptions?.onAssertion?.(dummyAssertion);
    }).not.toThrow();

    expect(store.get(run.id)).toBeUndefined(); // still evicted
  });
});
