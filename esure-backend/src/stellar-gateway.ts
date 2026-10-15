import {
  Asset,
  BASE_FEE,
  Horizon,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import type {
  AssertionResult,
  FriendbotRetryConfig,
  LedgerExecution,
  LedgerExecutionOptions,
  LedgerGateway,
  ScenarioAssertion,
  ScenarioAsset,
  ScenarioStep,
  StepResult,
  ValidatedScenario,
} from "./domain.js";
import { SafeRunError, StepTimeoutError, withTimeout } from "./errors.js";
import { interpretOperationCode, interpretTransactionCode, isStellarErrorRetryable } from "./stellar-error-interpreter.js";

export type { FriendbotRetryConfig };

export interface StellarGatewayOptions {
  friendbotRetry?: FriendbotRetryConfig;
  horizonRetry?: HorizonRetryConfig;
  fetch?: typeof fetch;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export interface HorizonRetryConfig {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  factor?: number;
  random?: () => number;
}

export const DEFAULT_FRIENDBOT_RETRY_CONFIG = {
  maxAttempts: 3,
  baseDelayMs: 1_000,
  maxDelayMs: 4_000,
  factor: 2,
} as const;

export const DEFAULT_HORIZON_RETRY_CONFIG = {
  maxRetries: 3,
  baseDelayMs: 1_000,
  maxDelayMs: 4_000,
  factor: 2,
} as const;

export function calculateRetryDelay(
  attempt: number,
  config: FriendbotRetryConfig | HorizonRetryConfig = {},
): number {
  const baseDelayMs = config.baseDelayMs ?? DEFAULT_FRIENDBOT_RETRY_CONFIG.baseDelayMs;
  const maxDelayMs = config.maxDelayMs ?? DEFAULT_FRIENDBOT_RETRY_CONFIG.maxDelayMs;
  const factor = config.factor ?? DEFAULT_FRIENDBOT_RETRY_CONFIG.factor;
  const random = config.random ?? Math.random;

  const exponential = baseDelayMs * Math.pow(factor, Math.max(0, attempt - 1));
  const bounded = Math.min(maxDelayMs, exponential);
  return Math.floor(random() * bounded);
}

export function signalSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("The operation was aborted."));
      return;
    }
    let timer: NodeJS.Timeout | undefined;
    const onAbort = () => {
      if (timer !== undefined) clearTimeout(timer);
      cleanup();
      reject(signal?.reason ?? new Error("The operation was aborted."));
    };
    const cleanup = () => {
      signal?.removeEventListener("abort", onAbort);
    };
    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
    }
    timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
  });
}

interface StepOutcome {
  result: StepResult;
  transactionCode?: string;
  operationCodes?: string[];
  succeeded: boolean;
}

export class StellarTestnetGateway implements LedgerGateway {
  readonly #server: Horizon.Server;
  readonly #options: StellarGatewayOptions;

  constructor(
    horizonUrl: string,
    private readonly friendbotUrl: string,
    options: StellarGatewayOptions = {},
  ) {
    this.#server = new Horizon.Server(horizonUrl);
    this.#options = options;
  }

  async execute(scenario: ValidatedScenario, options: LedgerExecutionOptions = {}): Promise<LedgerExecution> {
    const accounts = new Map(scenario.accounts.map((account) => [account.id, Keypair.random()]));
    const assets = new Map(scenario.assets.map((asset) => [asset.id, this.resolveAsset(asset, accounts)]));
    const steps: StepResult[] = [];
    const assertions: AssertionResult[] = [];
    const outcomes = new Map<string, StepOutcome>();

    const funded = scenario.accounts.filter((account) => account.fund);
    if (funded.length) {
      await this.performRequiredStep("fund-accounts", "fundAccounts", options, steps, async (signal) => {
        await Promise.all(funded.map((account) => this.fund(required(accounts, account.id), signal, options.friendbotRetry)));
        return basicStep("fund-accounts", "fundAccounts", "Test accounts funded.");
      });
    }

    const initialBalances = new Map<string, string>();
    for (const assertion of scenario.assertions) {
      if (assertion.type !== "balanceChangedBy") continue;
      const key = balanceKey(assertion.account, assertion.asset);
      if (!initialBalances.has(key)) {
        initialBalances.set(key, await this.readBalanceOrZero(required(accounts, assertion.account).publicKey(), required(assets, assertion.asset), options, `initial-${assertion.account}-${assertion.asset}`));
      }
    }

    for (const definition of scenario.steps) {
      const expectedFailure = scenario.assertions.find((assertion): assertion is Extract<ScenarioAssertion, { type: "stepFailedWith" }> => assertion.type === "stepFailedWith" && assertion.step === definition.id);
      try {
        const result = await executeBounded(definition.id, options, async () => this.executeOperation(definition, accounts, assets));
        const outcome = { result, succeeded: true } satisfies StepOutcome;
        outcomes.set(definition.id, outcome);
        recordStep(steps, result, options);
      } catch (error) {
        const safe = normalizeStellarError(error, definition.id);
        const exactExpectedFailure = expectedFailure && matchesFailure(safe, expectedFailure.transactionCode, expectedFailure.operationCodes);
        const failed = failureStep(definition, safe, Boolean(exactExpectedFailure));
        outcomes.set(definition.id, {
          result: failed,
          succeeded: false,
          ...(safe.report.stellarTransactionCode && { transactionCode: safe.report.stellarTransactionCode }),
          ...(safe.report.stellarOperationCodes && { operationCodes: safe.report.stellarOperationCodes }),
        });
        recordStep(steps, failed, options);
        if (!exactExpectedFailure) throw safe;
      }
    }

    for (const definition of scenario.assertions) {
      try {
        const result = await this.evaluateAssertion(definition, accounts, assets, outcomes, initialBalances, options);
        recordAssertion(assertions, result, options);
      } catch (error) {
        throw normalizeStellarError(error, `assert-${definition.type}`);
      }
    }
    return { steps, assertions };
  }

  private resolveAsset(definition: ScenarioAsset, accounts: Map<string, Keypair>): Asset {
    return definition.type === "native"
      ? Asset.native()
      : new Asset(definition.code, required(accounts, definition.issuer).publicKey());
  }

  private async executeOperation(definition: ScenarioStep, accounts: Map<string, Keypair>, assets: Map<string, Asset>): Promise<StepResult> {
    if (definition.type === "changeTrust") {
      const response = await this.submit(required(accounts, definition.account), [Operation.changeTrust({ asset: required(assets, definition.asset), ...(definition.limit && { limit: definition.limit }) })]);
      return transactionStep(definition.id, definition.type, response);
    }
    if (definition.type === "payment") {
      const response = await this.submit(required(accounts, definition.from), [Operation.payment({
        destination: required(accounts, definition.to).publicKey(),
        asset: required(assets, definition.asset),
        amount: definition.amount,
      })]);
      return transactionStep(definition.id, definition.type, response);
    }
    if (definition.type === "manageSellOffer") {
      const response = await this.submit(required(accounts, definition.account), [Operation.manageSellOffer({
        selling: required(assets, definition.sellingAsset),
        buying: required(assets, definition.buyingAsset),
        amount: definition.amount,
        price: definition.price,
      })]);
      return transactionStep(definition.id, definition.type, response);
    }

    const path = definition.path.map((assetId) => required(assets, assetId));
    const operation = definition.type === "pathPaymentStrictReceive"
      ? Operation.pathPaymentStrictReceive({
        sendAsset: required(assets, definition.sendAsset),
        sendMax: definition.sendMax,
        destination: required(accounts, definition.to).publicKey(),
        destAsset: required(assets, definition.destAsset),
        destAmount: definition.destAmount,
        path,
      })
      : Operation.pathPaymentStrictSend({
        sendAsset: required(assets, definition.sendAsset),
        sendAmount: definition.sendAmount,
        destination: required(accounts, definition.to).publicKey(),
        destAsset: required(assets, definition.destAsset),
        destMin: definition.destMin,
        path,
      });
    const response = await this.submit(required(accounts, definition.from), [operation]);
    return transactionStep(definition.id, definition.type, response);
  }

  private async evaluateAssertion(
    definition: ScenarioAssertion,
    accounts: Map<string, Keypair>,
    assets: Map<string, Asset>,
    outcomes: Map<string, StepOutcome>,
    initialBalances: Map<string, string>,
    options: LedgerExecutionOptions,
  ): Promise<AssertionResult> {
    switch (definition.type) {
      case "balanceEquals": {
        const actual = await this.readBalanceOrZero(required(accounts, definition.account).publicKey(), required(assets, definition.asset), options, `assert-${definition.type}`);
        return comparison(definition.type, canonicalDecimal(definition.amount), canonicalDecimal(actual), `Balance for ${definition.account}/${definition.asset} matched.`);
      }
      case "balanceChangedBy": {
        const before = required(initialBalances, balanceKey(definition.account, definition.asset));
        const after = await this.readBalanceOrZero(required(accounts, definition.account).publicKey(), required(assets, definition.asset), options, `assert-${definition.type}`);
        return balanceDeltaAssertion(before, after, definition.amount, `Balance for ${definition.account}/${definition.asset} changed by ${canonicalDecimal(definition.amount)}.`);
      }
      case "stepSucceeded": {
        const actual = required(outcomes, definition.step).succeeded;
        return comparison(definition.type, true, actual, `Step ${definition.step} succeeded.`);
      }
      case "stepFailedWith": {
        const outcome = required(outcomes, definition.step);
        const expected = failureCode(definition.transactionCode, definition.operationCodes);
        const actual = outcome.succeeded ? "transaction_succeeded" : failureCode(outcome.transactionCode, outcome.operationCodes);
        return comparison(definition.type, expected, actual, `Step ${definition.step} failed with ${expected} as expected.`);
      }
      case "transactionConfirmed": {
        const outcome = required(outcomes, definition.step);
        const actual = Boolean(outcome.succeeded && outcome.result.transactionHash && outcome.result.ledger);
        return comparison(definition.type, true, actual, `Transaction for step ${definition.step} was confirmed.`);
      }
      case "accountExists": {
        const actual = await executeBounded(`assert-${definition.type}`, options, async () => this.accountExists(required(accounts, definition.account).publicKey()));
        return comparison(definition.type, true, actual, `Account ${definition.account} exists on Testnet.`);
      }
      case "trustlineExists":
      case "trustlineMissing": {
        const exists = await executeBounded(`assert-${definition.type}`, options, async () => this.trustlineExists(required(accounts, definition.account).publicKey(), required(assets, definition.asset)));
        const expected = definition.type === "trustlineExists";
        return comparison(definition.type, expected, exists, `Trustline ${definition.account}/${definition.asset} is ${expected ? "present" : "absent"}.`);
      }
    }
  }

  private async performRequiredStep(id: string, type: string, options: LedgerExecutionOptions, steps: StepResult[], action: (signal: AbortSignal) => Promise<StepResult>): Promise<void> {
    try {
      recordStep(steps, await executeBounded(id, options, action), options);
    } catch (error) {
      const safe = normalizeStellarError(error, id);
      recordStep(steps, failureStep({ id, type } as ScenarioStep, safe, false), options);
      throw safe;
    }
  }

  async fundAccount(
    publicKey: string,
    signal?: AbortSignal,
    retryOverrides?: FriendbotRetryConfig,
  ): Promise<void> {
    const url = new URL(this.friendbotUrl);
    url.searchParams.set("addr", publicKey);

    const retryConfig = {
      maxAttempts: Math.max(1, retryOverrides?.maxAttempts ?? this.#options.friendbotRetry?.maxAttempts ?? DEFAULT_FRIENDBOT_RETRY_CONFIG.maxAttempts),
      baseDelayMs: retryOverrides?.baseDelayMs ?? this.#options.friendbotRetry?.baseDelayMs ?? DEFAULT_FRIENDBOT_RETRY_CONFIG.baseDelayMs,
      maxDelayMs: retryOverrides?.maxDelayMs ?? this.#options.friendbotRetry?.maxDelayMs ?? DEFAULT_FRIENDBOT_RETRY_CONFIG.maxDelayMs,
      factor: retryOverrides?.factor ?? this.#options.friendbotRetry?.factor ?? DEFAULT_FRIENDBOT_RETRY_CONFIG.factor,
      random: retryOverrides?.random ?? this.#options.friendbotRetry?.random ?? Math.random,
    };

    const fetchFn = this.#options.fetch ?? fetch;
    const sleepFn = this.#options.sleep ?? signalSleep;

    let attempt = 0;
    while (attempt < retryConfig.maxAttempts) {
      if (signal?.aborted) {
        throw signal.reason ?? new Error("The operation was aborted.");
      }
      attempt += 1;

      let response: Response;
      try {
        response = await fetchFn(url, { ...(signal && { signal }) });
      } catch (error) {
        if (signal?.aborted) throw error;
        if (attempt >= retryConfig.maxAttempts) {
          throw new SafeRunError({
            code: "FRIENDBOT_UNAVAILABLE",
            message: "Friendbot could not be reached.",
            category: "network",
            retryable: true,
            failedStepId: "fund-accounts",
          });
        }
        const delay = calculateRetryDelay(attempt, retryConfig);
        await sleepFn(delay, signal);
        continue;
      }

      if (response.ok) {
        return;
      }

      const isRetryable = response.status === 429 || response.status >= 500;
      if (!isRetryable || attempt >= retryConfig.maxAttempts) {
        throw new SafeRunError({
          code: "FRIENDBOT_UNAVAILABLE",
          message: `Friendbot rejected the funding request with HTTP ${response.status}.`,
          category: "network",
          retryable: isRetryable,
          failedStepId: "fund-accounts",
        });
      }

      const delay = calculateRetryDelay(attempt, retryConfig);
      await sleepFn(delay, signal);
    }
  }

  private async fund(keypair: Keypair, signal: AbortSignal, retryOverrides?: FriendbotRetryConfig): Promise<void> {
    return this.fundAccount(keypair.publicKey(), signal, retryOverrides);
  }


  private async submit(source: Keypair, operations: Array<
    ReturnType<typeof Operation.payment> |
    ReturnType<typeof Operation.changeTrust> |
    ReturnType<typeof Operation.manageSellOffer> |
    ReturnType<typeof Operation.pathPaymentStrictReceive> |
    ReturnType<typeof Operation.pathPaymentStrictSend>
  >) {
    const account = await this.withHorizonRetry(() => this.#server.loadAccount(source.publicKey()));
    const builder = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: Networks.TESTNET, timebounds: await this.#server.fetchTimebounds(60) });
    for (const operation of operations) builder.addOperation(operation);
    const transaction = builder.build();
    transaction.sign(source);
    return this.withHorizonRetry(() => this.#server.submitTransaction(transaction));
  }

  private async readBalanceOrZero(publicKey: string, asset: Asset, options: LedgerExecutionOptions, stepId: string): Promise<string> {
    try {
      return await executeBounded(stepId, options, async () => {
        try { return await this.balance(publicKey, asset); }
        catch (error) { if (isNotFound(error)) return "0"; throw error; }
      });
    } catch (error) {
      throw normalizeStellarError(error, stepId);
    }
  }

  private async balance(publicKey: string, asset: Asset): Promise<string> {
    const account = await this.withHorizonRetry(() => this.#server.loadAccount(publicKey));
    const found = account.balances.find((balance) => asset.isNative()
      ? balance.asset_type === "native"
      : "asset_code" in balance && balance.asset_code === asset.getCode() && "asset_issuer" in balance && balance.asset_issuer === asset.getIssuer());
    return found?.balance ?? "0";
  }

  private async accountExists(publicKey: string): Promise<boolean> {
    try { await this.withHorizonRetry(() => this.#server.loadAccount(publicKey)); return true; }
    catch (error) { if (isNotFound(error)) return false; throw error; }
  }

  private async trustlineExists(publicKey: string, asset: Asset): Promise<boolean> {
    const account = await this.withHorizonRetry(() => this.#server.loadAccount(publicKey));
    return account.balances.some((balance) => "asset_code" in balance && balance.asset_code === asset.getCode() && "asset_issuer" in balance && balance.asset_issuer === asset.getIssuer());
  }

  private async withHorizonRetry<T>(operation: () => Promise<T>): Promise<T> {
    const config = {
      maxRetries: Math.max(0, this.#options.horizonRetry?.maxRetries ?? DEFAULT_HORIZON_RETRY_CONFIG.maxRetries),
      baseDelayMs: this.#options.horizonRetry?.baseDelayMs ?? DEFAULT_HORIZON_RETRY_CONFIG.baseDelayMs,
      maxDelayMs: this.#options.horizonRetry?.maxDelayMs ?? DEFAULT_HORIZON_RETRY_CONFIG.maxDelayMs,
      factor: this.#options.horizonRetry?.factor ?? DEFAULT_HORIZON_RETRY_CONFIG.factor,
      random: this.#options.horizonRetry?.random ?? Math.random,
    };
    const sleepFn = this.#options.sleep ?? signalSleep;
    let retries = 0;

    while (true) {
      try {
        return await operation();
      } catch (error) {
        if (!isRetryableHorizonError(error)) throw error;
        if (retries >= config.maxRetries) {
          throw new SafeRunError({
            code: "HORIZON_UNAVAILABLE",
            message: `Horizon request failed after ${retries} retries.`,
            category: "network",
            retryable: true,
          });
        }
        retries += 1;
        const delay = calculateRetryDelay(retries, config);
        await sleepFn(delay);
      }
    }
  }
}

async function executeBounded<T>(stepId: string, options: LedgerExecutionOptions, action: (signal: AbortSignal) => Promise<T>): Promise<T> {
  if (options.signal?.aborted) throw new SafeRunError({ code: "RUN_TIMEOUT", message: "The run was cancelled after reaching its execution limit.", category: "timeout", retryable: true, failedStepId: stepId });
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  return withTimeout(action(signal), options.stepTimeoutMs ?? 30_000, () => new StepTimeoutError(stepId, options.stepTimeoutMs ?? 30_000), () => controller.abort());
}

function recordStep(steps: StepResult[], result: StepResult, options: LedgerExecutionOptions): void { steps.push(result); options.onStep?.(structuredClone(result)); }
function recordAssertion(assertions: AssertionResult[], result: AssertionResult, options: LedgerExecutionOptions): void { assertions.push(result); options.onAssertion?.(structuredClone(result)); }
function basicStep(id: string, type: string, message: string): StepResult { return { id, type, status: "passed", message }; }
function transactionStep(id: string, type: string, response: Horizon.HorizonApi.SubmitTransactionResponse): StepResult { return { id, type, status: "passed", transactionHash: response.hash, ledger: response.ledger, message: "Transaction confirmed on Stellar Testnet." }; }

function failureStep(definition: Pick<ScenarioStep, "id" | "type">, safe: SafeRunError, expected: boolean): StepResult {
  return {
    id: definition.id, type: definition.type, status: expected ? "passed" : "failed",
    ...(safe.report.stellarTransactionCode && { stellarTransactionCode: safe.report.stellarTransactionCode }),
    ...(safe.report.stellarOperationCodes && { stellarOperationCodes: safe.report.stellarOperationCodes }),
    message: expected ? `Operation failed with ${failureCode(safe.report.stellarTransactionCode, safe.report.stellarOperationCodes)} as expected.` : safe.report.message,
  };
}

function comparison(type: AssertionResult["type"], expected: AssertionResult["expected"], actual: AssertionResult["actual"], success: string): AssertionResult {
  const passed = JSON.stringify(actual) === JSON.stringify(expected);
  return { type, status: passed ? "passed" : "failed", expected, actual, message: passed ? success : `Expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}.` };
}

export function balanceDeltaAssertion(before: string, after: string, expectedDelta: string, success: string): AssertionResult {
  const actual = stroopsToDecimal(decimalToStroops(after) - decimalToStroops(before));
  return comparison("balanceChangedBy", canonicalDecimal(expectedDelta), actual, success);
}

export function matchesFailure(error: unknown, transactionCode: string, operationCodes: string[]): boolean {
  if (!(error instanceof SafeRunError)) return false;
  return error.report.stellarTransactionCode === transactionCode && JSON.stringify(error.report.stellarOperationCodes ?? []) === JSON.stringify(operationCodes);
}

export function isExpectedMissingTrustlineError(error: unknown): boolean { return matchesFailure(error, "tx_failed", ["op_no_trust"]); }

export function normalizeStellarError(error: unknown, failedStepId: string): SafeRunError {
  if (error instanceof SafeRunError) { if (!error.report.failedStepId) error.report.failedStepId = failedStepId; return error; }
  const codes = extractStellarResultCodes(error);
  if (codes) {
    const txInterpretation = interpretTransactionCode(codes.transactionCode);
    const retryable = isStellarErrorRetryable(codes.transactionCode, codes.operationCodes);
    const firstOpCode = codes.operationCodes[0];
    const opSummary = firstOpCode ? ` ${interpretOperationCode(firstOpCode).summary}.` : "";
    const message = `Stellar rejected step ${failedStepId}: ${txInterpretation.summary}.${opSummary}`;
    return new SafeRunError({ code: "STELLAR_TRANSACTION_FAILED", message, category: "stellar", retryable, failedStepId, stellarTransactionCode: codes.transactionCode, stellarOperationCodes: codes.operationCodes });
  }
  return new SafeRunError({ code: "NETWORK_UNAVAILABLE", message: `Stellar network execution failed during step ${failedStepId}. Internal details were removed.`, category: "network", retryable: true, failedStepId });
}

function extractStellarResultCodes(error: unknown): { transactionCode: string; operationCodes: string[] } | undefined {
  if (!isRecord(error)) return undefined;
  const response = isRecord(error.response) ? error.response : undefined;
  const data = response && isRecord(response.data) ? response.data : undefined;
  const extras = data && isRecord(data.extras) ? data.extras : undefined;
  const resultCodes = extras && isRecord(extras.result_codes) ? extras.result_codes : undefined;
  const transactionCode = resultCodes && safeCode(resultCodes.transaction);
  if (!transactionCode) return undefined;
  const operationCodes = Array.isArray(resultCodes?.operations) ? resultCodes.operations.map(safeCode).filter((value): value is string => Boolean(value)).slice(0, 100) : [];
  return { transactionCode, operationCodes };
}

function required<K, V>(map: Map<K, V>, key: K): V { const value = map.get(key); if (value === undefined) throw new Error(`Validated reference was unavailable: ${String(key)}`); return value; }
function balanceKey(account: string, asset: string): string { return `${account}\u0000${asset}`; }
function failureCode(transaction?: string, operations?: string[]): string { return `${transaction ?? "no_transaction_code"}/${operations?.join(",") || "no_operation_code"}`; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null; }
function safeCode(value: unknown): string | undefined { return typeof value === "string" && /^[a-z0-9_]{1,64}$/.test(value) ? value : undefined; }
function isNotFound(error: unknown): boolean { return isRecord(error) && isRecord(error.response) && error.response.status === 404; }
function isRetryableHorizonError(error: unknown): boolean {
  if (!isRecord(error)) return false;
  const response = isRecord(error.response) ? error.response : undefined;
  const status = response?.status;
  if (status === 429 || status === 503) return true;
  if (typeof status === "number") return false;
  const code = typeof error.code === "string" ? error.code.toUpperCase() : "";
  const name = typeof error.name === "string" ? error.name.toLowerCase() : "";
  const message = typeof error.message === "string" ? error.message.toLowerCase() : "";
  return ["ECONNABORTED", "ETIMEDOUT", "ESOCKETTIMEDOUT"].includes(code)
    || name === "timeouterror"
    || message.includes("timeout")
    || message.includes("timed out");
}

export function canonicalDecimal(value: string): string {
  const [integer = "0", fraction = ""] = value.split(".");
  const normalizedInteger = integer.replace(/^0+(?=\d)/, "");
  const normalizedFraction = fraction.replace(/0+$/, "");
  return normalizedFraction ? `${normalizedInteger}.${normalizedFraction}` : normalizedInteger;
}
function decimalToStroops(value: string): bigint { if (!/^-?\d+(?:\.\d{1,7})?$/.test(value)) throw new Error("Balance must be a decimal with at most seven places"); const negative = value.startsWith("-"); const absolute = negative ? value.slice(1) : value; const [integer = "0", fraction = ""] = absolute.split("."); const stroops = BigInt(integer) * 10_000_000n + BigInt(fraction.padEnd(7, "0")); return negative ? -stroops : stroops; }
function stroopsToDecimal(value: bigint): string { const sign = value < 0n ? "-" : ""; const absolute = value < 0n ? -value : value; const integer = absolute / 10_000_000n; const fraction = (absolute % 10_000_000n).toString().padStart(7, "0").replace(/0+$/, ""); return `${sign}${integer}${fraction ? `.${fraction}` : ""}`; }
