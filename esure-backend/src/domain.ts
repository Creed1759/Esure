export type RunStatus = "requested" | "validating" | "running" | "passed" | "failed";
export type StepStatus = "passed" | "failed";

/**
 * Bounded set of operation categories derivable from a scenario's steps and
 * assertions without executing it. This lets dashboard clients filter by
 * category without re-parsing step/assertion lists or inferring meaning from
 * free-text names and descriptions.
 *
 * Values:
 *   - "payment"           – at least one payment step is present
 *   - "trust"             – at least one changeTrust step is present
 *   - "offer"             – at least one manageSellOffer step is present
 *   - "path-payment"      – at least one pathPaymentStrictReceive or pathPaymentStrictSend step
 *   - "failure-assertion" – at least one stepFailedWith assertion is present
 */
export type ScenarioCategory = "payment" | "trust" | "offer" | "path-payment" | "failure-assertion";

export interface ScenarioSummary {
  id: string;
  version: number;
  name: string;
  description: string;
  contentHash: string;
  /** Bounded categories derived from the scenario's validated operations and assertions (issue #230). */
  categories: ScenarioCategory[];
}

export interface ScenarioAccount {
  id: string;
  generate: true;
  fund: boolean;
}

export type ScenarioAsset =
  | { id: string; type: "native" }
  | { id: string; type: "issued"; code: string; issuer: string };

export type ScenarioStep =
  | { id: string; type: "changeTrust"; account: string; asset: string; limit?: string }
  | { id: string; type: "payment"; from: string; to: string; asset: string; amount: string; memo?: string }
  | { id: string; type: "manageSellOffer"; account: string; sellingAsset: string; buyingAsset: string; amount: string; price: string }
  | { id: string; type: "pathPaymentStrictReceive"; from: string; to: string; sendAsset: string; sendMax: string; destAsset: string; destAmount: string; path: string[] }
  | { id: string; type: "pathPaymentStrictSend"; from: string; to: string; sendAsset: string; sendAmount: string; destAsset: string; destMin: string; path: string[] };

export type ScenarioAssertion =
  | { type: "transactionMemoEquals"; step: string; memo: string }
  | { type: "balanceEquals" | "balanceChangedBy"; account: string; asset: string; amount: string }
  | { type: "stepSucceeded" | "transactionConfirmed"; step: string }
  | { type: "stepFailedWith"; step: string; transactionCode: string; operationCodes: string[] }
  | { type: "trustlineExists" | "trustlineMissing"; account: string; asset: string }
  | { type: "trustlineLimitEquals"; account: string; asset: string; limit: string }
  | { type: "accountExists" | "accountMissing"; account: string }
  | { type: "feeAwareNativeBalanceDelta"; account: string; asset: string; amount: string; step: string };

export interface ScenarioDefinition {
  schemaVersion: 1;
  id: string;
  version: number;
  name: string;
  description: string;
  network: "testnet";
  accounts: ScenarioAccount[];
  assets: ScenarioAsset[];
  steps: ScenarioStep[];
  assertions: ScenarioAssertion[];
}

export interface ValidatedScenario extends ScenarioDefinition {
  contentHash: string;
}

/** @deprecated Use ValidatedScenario. Kept for gateway adapters during Schema v1 migration. */
export type Scenario = ValidatedScenario;

export interface StepResult {
  id: string;
  type: string;
  status: StepStatus;
  transactionHash?: string;
  ledger?: number;
  /** Actual fee charged for this transaction in stroops (integer string). Present only when fee evidence is available from the confirmed transaction. */
  feeCharged?: string;
  stellarTransactionCode?: string;
  stellarOperationCodes?: string[];
  message: string;
  /**
   * Issue #83: step timing evidence. These fields are additive — older
   * reports without them remain valid, and consumers must treat them as
   * optional. `startedAt`/`completedAt` are ISO-8601 timestamps suitable for
   * display; `durationMs` is derived from a monotonic clock
   * (`performance.now()`) and is therefore safe to use for measuring
   * elapsed time even if the system clock changes mid-run.
   */
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
}

export type AssertionValue = string | boolean | number | null | Record<string, unknown> | unknown[];

export interface AssertionResult {
  type: ScenarioAssertion["type"];
  status: StepStatus;
  expected: AssertionValue;
  actual: AssertionValue;
  message: string;
  /**
   * Issue #84: bounded optional subject references copied from the validated
   * assertion definition. Clients can use these to identify which account,
   * asset, or step an assertion targets without re-parsing the scenario.
   */
  account?: string;
  asset?: string;
  step?: string;
}

export type RunErrorCategory = "stellar" | "network" | "timeout" | "capacity" | "validation" | "internal";

export interface RunError {
  code: string;
  message: string;
  category: RunErrorCategory;
  retryable: boolean;
  failedStepId?: string;
  stellarTransactionCode?: string;
  stellarOperationCodes?: string[];
}

export interface RunSummary {
  stepsPassed: number;
  stepsFailed: number;
  assertionsPassed: number;
  assertionsFailed: number;
}

export interface RunReport {
  id: string;
  scenarioId: string;
  scenarioVersion: number;
  scenarioSchemaVersion: 1;
  scenarioContentHash: string;
  network: "testnet";
  status: RunStatus;
  createdAt: string;
  completedAt?: string;
  expiresAt?: string;
  steps: StepResult[];
  assertions: AssertionResult[];
  summary: RunSummary;
  error?: RunError;
}

export interface LedgerExecution {
  steps: StepResult[];
  assertions: AssertionResult[];
}

export interface FriendbotRetryConfig {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  factor?: number;
  random?: () => number;
}

export interface LedgerGateway {
  execute(scenario: ValidatedScenario, options?: LedgerExecutionOptions): Promise<LedgerExecution>;
}

export interface LedgerExecutionOptions {
  signal?: AbortSignal;
  stepTimeoutMs?: number;
  onStep?: (step: StepResult) => void;
  onAssertion?: (assertion: AssertionResult) => void;
  friendbotRetry?: FriendbotRetryConfig;
}
