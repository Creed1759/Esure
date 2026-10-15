import type { RunError } from "./domain.js";

export class SafeRunError extends Error {
  constructor(readonly report: RunError) {
    super(report.message);
    this.name = "SafeRunError";
  }
}

export class RunCapacityError extends SafeRunError {
  constructor(message = "The runner is at capacity. Try again later.") {
    super({ code: "RUNNER_AT_CAPACITY", message, category: "capacity", retryable: true });
    this.name = "RunCapacityError";
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
