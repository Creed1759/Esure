export type RunStatus = "requested" | "validating" | "running" | "passed" | "failed";
export type StepStatus = "passed" | "failed";

export interface ScenarioSummary {
  id: string;
  version: number;
  name: string;
  description: string;
  contentHash: string;
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
  | { id: string; type: "payment"; from: string; to: string; asset: string; amount: string }
  | { id: string; type: "manageSellOffer"; account: string; sellingAsset: string; buyingAsset: string; amount: string; price: string }
  | { id: string; type: "pathPaymentStrictReceive"; from: string; to: string; sendAsset: string; sendMax: string; destAsset: string; destAmount: string; path: string[] }
  | { id: string; type: "pathPaymentStrictSend"; from: string; to: string; sendAsset: string; sendAmount: string; destAsset: string; destMin: string; path: string[] };

export type ScenarioAssertion =
  | { type: "balanceEquals" | "balanceChangedBy"; account: string; asset: string; amount: string }
  | { type: "stepSucceeded" | "transactionConfirmed"; step: string }
  | { type: "stepFailedWith"; step: string; transactionCode: string; operationCodes: string[] }
  | { type: "trustlineExists" | "trustlineMissing"; account: string; asset: string }
  | { type: "accountExists"; account: string };

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
  stellarTransactionCode?: string;
  stellarOperationCodes?: string[];
  message: string;
}

export type AssertionValue = string | boolean | number | null | Record<string, unknown> | unknown[];

export interface AssertionResult {
  type: ScenarioAssertion["type"];
  status: StepStatus;
  expected: AssertionValue;
  actual: AssertionValue;
  message: string;
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
