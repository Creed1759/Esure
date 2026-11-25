import type { RunError } from "./domain.js";

export class SafeRunError extends Error {
  constructor(readonly report: RunError) {
    super(report.message);
    this.name = "SafeRunError";
  }
}

const TESTNET_RETRY_SUGGESTION = "This may be a temporary Testnet issue. Try again.";

export function friendbotTimeoutError(failedStepId: string): SafeRunError {
  return new SafeRunError({
    code: "FRIENDBOT_UNAVAILABLE",
    message: `Friendbot did not respond in time. ${TESTNET_RETRY_SUGGESTION}`,
    category: "network",
    retryable: true,
    failedStepId,
  });
}

export function horizonTimeoutError(
  request: "transaction submission" | "account loading" | "transaction lookup",
): SafeRunError {
  const service = request === "transaction submission"
    ? "Horizon transaction submission"
    : request === "transaction lookup" ? "Horizon transaction lookup" : "Horizon account loading";
  return new SafeRunError({
    code: "HORIZON_UNAVAILABLE",
    message: `${service} timed out. ${TESTNET_RETRY_SUGGESTION}`,
    category: "network",
    retryable: true,
  });
}

export class RunCapacityError extends SafeRunError {
  constructor(message = "The runner is at capacity. Try again later.") {
    super({ code: "RUNNER_AT_CAPACITY", message, category: "capacity", retryable: true });
    this.name = "RunCapacityError";
  }
}

/**
 * Thrown when a run-start is rejected because the service is draining
 * (graceful shutdown in progress).  Distinct from RunCapacityError so that
 * callers can tell a temporary capacity limit from a permanent drain — the
 * latter warrants a longer Retry-After and a different error code.
 * Issue #223.
 */
export class RunDrainingError extends SafeRunError {
  constructor() {
    super({ code: "SERVER_DRAINING", message: "The server is shutting down. No new runs are accepted.", category: "capacity", retryable: true });
    this.name = "RunDrainingError";
  }
}

export class StepTimeoutError extends SafeRunError {
  constructor(stepId: string, timeoutMs: number) {
    super({
      code: "STEP_TIMEOUT",
      message: `Step ${stepId} exceeded its ${timeoutMs}ms execution limit.`,
      category: "timeout",
      retryable: true,
      failedStepId: stepId,
    });
    this.name = "StepTimeoutError";
  }
}

export class RunTimeoutError extends SafeRunError {
  constructor(timeoutMs: number) {
    super({
      code: "RUN_TIMEOUT",
      message: `The run exceeded its ${timeoutMs}ms execution limit.`,
      category: "timeout",
      retryable: true,
    });
    this.name = "RunTimeoutError";
  }
}

export class OptimisticConcurrencyError extends SafeRunError {
  constructor(runId: string) {
    super({
      code: "OPTIMISTIC_CONCURRENCY_CONFLICT",
      message: `Run ${runId} was modified by another writer; the update was rejected.`,
      category: "internal",
      retryable: true,
    });
    this.name = "OptimisticConcurrencyError";
  }
}

export class ShutdownError extends SafeRunError {
  constructor() {
    super({
      code: "SERVER_SHUTDOWN",
      message: "The server is shutting down. The run was cancelled.",
      category: "internal",
      retryable: true,
    });
    this.name = "ShutdownError";
  }
}

export async function withTimeout<T>(
  task: Promise<T>,
  timeoutMs: number,
  timeoutError: () => Error,
  onTimeout?: () => void,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(timeoutError());
      onTimeout?.();
    }, timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([task, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
