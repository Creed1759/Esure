import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Horizon } from "@stellar/stellar-sdk";
import type { ValidatedScenario } from "../src/domain.js";
import { createScenarioRegistry } from "../src/scenarios.js";
import {
  balanceDeltaAssertion,
  calculateRetryDelay,
  canonicalDecimal,
  isExpectedMissingTrustlineError,
  normalizeStellarError,
  signalSleep,
  StellarTestnetGateway,
} from "../src/stellar-gateway.js";
import { SafeRunError } from "../src/errors.js";



describe("canonicalDecimal", () => {
  it("normalizes Horizon's fixed precision balances", () => {
    expect(canonicalDecimal("100.0000000")).toBe("100");
    expect(canonicalDecimal("001.2500000")).toBe("1.25");
  });

  it("preserves meaningful fractional digits", () => {
    expect(canonicalDecimal("0.0000001")).toBe("0.0000001");
  });
});

describe("balanceDeltaAssertion", () => {
  it("asserts the change rather than a fragile absolute Friendbot balance", () => {
    expect(balanceDeltaAssertion("9999.9999900", "10004.9999900", "5", "ok")).toMatchObject({
      type: "balanceChangedBy",
      status: "passed",
      expected: "5",
      actual: "5",
    });
  });

  it("reports the actual delta when it differs", () => {
    expect(balanceDeltaAssertion("10", "14.5", "5", "ok")).toMatchObject({ status: "failed", actual: "4.5" });
  });
});

describe("Stellar result-code normalization", () => {
  it("accepts only exact tx_failed/op_no_trust as the expected negative outcome", () => {
    const expected = normalizeStellarError(horizonError("tx_failed", ["op_no_trust"]), "send-testusd");
    expect(isExpectedMissingTrustlineError(expected)).toBe(true);

    for (const error of [
      horizonError("tx_failed", ["op_underfunded"]),
      horizonError("tx_failed", ["op_no_trust", "op_success"]),
      horizonError("tx_failed", []),
      horizonError("tx_bad_seq", []),
      new Error("network timeout"),
    ]) {
      expect(isExpectedMissingTrustlineError(normalizeStellarError(error, "send-testusd"))).toBe(false);
    }
  });

  it("returns allowlisted structured codes without leaking raw response details", () => {
    const secret = `S${"A".repeat(55)}`;
    const error = horizonError("tx_failed", ["op_no_trust"], secret);
    const normalized = normalizeStellarError(error, "send-testusd").report;
    expect(normalized).toMatchObject({
      code: "STELLAR_TRANSACTION_FAILED",
      category: "stellar",
      retryable: false,
      failedStepId: "send-testusd",
      stellarTransactionCode: "tx_failed",
      stellarOperationCodes: ["op_no_trust"],
    });
    expect(JSON.stringify(normalized)).not.toContain(secret);
  });
});

function horizonError(transaction: string, operations: string[], privateDetail = "removed") {
  return {
    response: {
      data: {
        extras: { result_codes: { transaction, operations }, result_xdr: privateDetail },
      },
    },
  };
}

describe("Friendbot retry delay calculation", () => {
  const deterministicConfig = {
    baseDelayMs: 1_000,
    maxDelayMs: 4_000,
    factor: 2,
    random: () => 1,
  };

  it("calculates exponential backoff", () => {
    expect(calculateRetryDelay(1, deterministicConfig)).toBe(1_000);
    expect(calculateRetryDelay(2, deterministicConfig)).toBe(2_000);
    expect(calculateRetryDelay(3, deterministicConfig)).toBe(4_000);
  });

  it("bounds delay to maxDelayMs", () => {
    expect(calculateRetryDelay(4, deterministicConfig)).toBe(4_000);
    expect(calculateRetryDelay(10, deterministicConfig)).toBe(4_000);
  });

  it("applies jitter scaling using the random generator", () => {
    const halfJitter = { ...deterministicConfig, random: () => 0.5 };
    expect(calculateRetryDelay(1, halfJitter)).toBe(500);
    expect(calculateRetryDelay(2, halfJitter)).toBe(1_000);

    const zeroJitter = { ...deterministicConfig, random: () => 0 };
    expect(calculateRetryDelay(1, zeroJitter)).toBe(0);
  });
});

describe("signalSleep", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves after the specified duration", async () => {
    let resolved = false;
    const promise = signalSleep(500).then(() => {
      resolved = true;
    });
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(500);
    await promise;
    expect(resolved).toBe(true);
  });

  it("rejects immediately if signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("pre-aborted"));
    await expect(signalSleep(500, controller.signal)).rejects.toThrow("pre-aborted");
  });

  it("rejects and cancels timer if signal is aborted mid-sleep", async () => {
    const controller = new AbortController();
    const promise = signalSleep(500, controller.signal);
    controller.abort(new Error("mid-sleep abort"));
    await expect(promise).rejects.toThrow("mid-sleep abort");
  });
});

describe("StellarTestnetGateway Friendbot bounded retry", () => {
  const publicKey = "GA2C5RFPE6GCKMY3US5PAB6UZLKIGAHWKXX2GJRZB2USWJY3CDTDNO5D";

  beforeEach(() => {
    vi.useFakeTimers();
  });

  describe("StellarTestnetGateway path payment operations", () => {
    const response = {
      hash: "a".repeat(64),
      ledger: 123,
    } as Horizon.HorizonApi.SubmitTransactionResponse;

    beforeEach(() => {
      vi.spyOn(Horizon.Server.prototype, "loadAccount")
        .mockImplementation(async (publicKey) => testHorizonAccount(publicKey));
      vi.spyOn(Horizon.Server.prototype, "fetchTimebounds").mockImplementation(async () => ({
        minTime: Math.floor(Date.now() / 1_000),
        maxTime: Math.floor(Date.now() / 1_000) + 60,
      }));
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("executes the bundled market-making and strict-receive path operations", async () => {
      const submittedTypes: string[] = [];
      const submitted = vi.spyOn(Horizon.Server.prototype, "submitTransaction").mockImplementation(async (transaction) => {
        submittedTypes.push(...transaction.operations.map((operation) => operation.type));
        return response;
      });
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(null, { status: 200 }));
      const gateway = new StellarTestnetGateway("https://horizon.example", "https://friendbot.example", {
        fetch,
        sleep: async () => {},
      });
      const bundledScenario = createScenarioRegistry().find("path-payment")!;
      const scenario = {
        ...bundledScenario,
        assertions: bundledScenario.assertions.filter((assertion) => assertion.type !== "balanceEquals"),
      };

      const execution = await gateway.execute(scenario);

      expect(execution.steps.at(-1)).toMatchObject({ id: "pay-usdc-through-eur", status: "passed" });
      expect(submittedTypes).toEqual([
        "changeTrust",
        "changeTrust",
        "changeTrust",
        "payment",
        "payment",
        "manageSellOffer",
        "manageSellOffer",
        "pathPaymentStrictReceive",
      ]);
      expect(submitted).toHaveBeenCalledTimes(8);
      expect(execution.assertions.every((assertion) => assertion.status === "passed")).toBe(true);
    });

    it("supports strict-send path payment operations", async () => {
      const submittedTypes: string[] = [];
      vi.spyOn(Horizon.Server.prototype, "submitTransaction").mockImplementation(async (transaction) => {
        submittedTypes.push(...transaction.operations.map((operation) => operation.type));
        return response;
      });
      const definition: ValidatedScenario = {
        schemaVersion: 1,
        id: "path-payment-strict-send-test",
        version: 1,
        name: "Strict-send test",
        description: "Exercises strict-send operation construction.",
        network: "testnet",
        contentHash: "sha256:test",
        accounts: [
          { id: "sender", generate: true, fund: false },
          { id: "recipient", generate: true, fund: false },
          { id: "issuer", generate: true, fund: false },
        ],
        assets: [
          { id: "xlm", type: "native" },
          { id: "usd", type: "issued", code: "USD", issuer: "issuer" },
        ],
        steps: [{
          id: "strict-send",
          type: "pathPaymentStrictSend",
          from: "sender",
          to: "recipient",
          sendAsset: "xlm",
          sendAmount: "2",
          destAsset: "usd",
          destMin: "1",
          path: [],
        }],
        assertions: [{ type: "stepSucceeded", step: "strict-send" }],
      };

      await new StellarTestnetGateway("https://horizon.example", "https://friendbot.example").execute(definition);

      expect(submittedTypes).toEqual(["pathPaymentStrictSend"]);
    });
  });

  function testHorizonAccount(publicKey: string): Horizon.AccountResponse {
    const unusedCollection = async (): Promise<never> => {
      throw new Error("Unexpected collection request in gateway test");
    };
    return new Horizon.AccountResponse({
      _links: { self: { href: "https://horizon.example/accounts/test" } },
      id: publicKey,
      paging_token: "1",
      account_id: publicKey,
      sequence: "1",
      subentry_count: 0,
      last_modified_ledger: 1,
      last_modified_time: "2026-01-01T00:00:00Z",
      thresholds: { low_threshold: 0, med_threshold: 0, high_threshold: 0 },
      flags: { auth_immutable: false, auth_required: false, auth_revocable: false, auth_clawback_enabled: false },
      balances: [],
      signers: [],
      num_sponsoring: 0,
      num_sponsored: 0,
      data: async () => ({ value: "" }),
      data_attr: {},
      effects: unusedCollection,
      offers: unusedCollection,
      operations: unusedCollection,
      payments: unusedCollection,
      trades: unusedCollection,
      transactions: unusedCollection,
    });
  }

  describe("StellarTestnetGateway Horizon retries", () => {
    const accountScenario: ValidatedScenario = {
      schemaVersion: 1,
      id: "horizon-account-retry",
      version: 1,
      name: "Horizon account retry",
      description: "Exercises Horizon account loading retries",
      network: "testnet",
      contentHash: "sha256:account",
      accounts: [{ id: "alice", generate: true, fund: false }],
      assets: [{ id: "xlm", type: "native" }],
      steps: [],
      assertions: [{ type: "accountExists", account: "alice" }],
    };

    function horizonResponseError(status: number): Error {
      return Object.assign(new Error(`HTTP ${status}`), { response: { status } });
    }

    function mockAccount(publicKey: string): Awaited<ReturnType<typeof Horizon.Server.prototype.loadAccount>> {
      const unusedCollection = async (): Promise<never> => {
        throw new Error("Unexpected collection request in gateway test");
      };
      const response: Horizon.ServerApi.AccountRecord = {
        _links: { self: { href: "https://horizon.example/accounts/test" } },
        id: publicKey,
        paging_token: "1",
        account_id: publicKey,
        sequence: "1",
        subentry_count: 0,
        last_modified_ledger: 1,
        last_modified_time: "2026-01-01T00:00:00Z",
        thresholds: { low_threshold: 0, med_threshold: 0, high_threshold: 0 },
        flags: { auth_immutable: false, auth_required: false, auth_revocable: false, auth_clawback_enabled: false },
        balances: [],
        signers: [],
        num_sponsoring: 0,
        num_sponsored: 0,
        data: async () => ({ value: "" }),
        data_attr: {},
        effects: unusedCollection,
        offers: unusedCollection,
        operations: unusedCollection,
        payments: unusedCollection,
        trades: unusedCollection,
        transactions: unusedCollection,
      };
      return new Horizon.AccountResponse(response);
    }

    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.restoreAllMocks();
      vi.useRealTimers();
    });

    it.each([429, 503])("retries account loading after HTTP %i and succeeds without real backoff delays", async (status) => {
      const loadAccount = vi.spyOn(Horizon.Server.prototype, "loadAccount")
        .mockRejectedValueOnce(horizonResponseError(status))
        .mockImplementation(async (publicKey) => mockAccount(publicKey));
      const sleep = vi.fn(async (_ms: number) => {});
      const gateway = new StellarTestnetGateway("https://horizon.example", "https://friendbot.example", {
        horizonRetry: { random: () => 1 },
        sleep,
      });

      const result = await gateway.execute(accountScenario);

      expect(result.assertions[0]).toMatchObject({ type: "accountExists", status: "passed" });
      expect(loadAccount).toHaveBeenCalledTimes(2);
      expect(sleep).toHaveBeenCalledExactlyOnceWith(1_000);
    });

    it("retries transaction submission after 503 and returns success", async () => {
      const loadAccount = vi.spyOn(Horizon.Server.prototype, "loadAccount")
        .mockImplementation(async (publicKey) => mockAccount(publicKey));
      vi.spyOn(Horizon.Server.prototype, "fetchTimebounds").mockImplementation(async () => ({
        minTime: Math.floor(Date.now() / 1_000),
        maxTime: Math.floor(Date.now() / 1_000) + 60,
      }));
      const submitTransaction = vi.spyOn(Horizon.Server.prototype, "submitTransaction")
        .mockRejectedValueOnce(horizonResponseError(503))
        .mockResolvedValueOnce({ hash: "transaction-hash", ledger: 123 } as Horizon.HorizonApi.SubmitTransactionResponse);
      const sleep = vi.fn(async (_ms: number) => {});
      const gateway = new StellarTestnetGateway("https://horizon.example", "https://friendbot.example", {
        horizonRetry: { random: () => 1 },
        sleep,
      });
      const scenario: ValidatedScenario = {
        ...accountScenario,
        id: "horizon-submit-retry",
        accounts: [
          { id: "alice", generate: true, fund: false },
          { id: "bob", generate: true, fund: false },
        ],
        steps: [{ id: "payment", type: "payment", from: "alice", to: "bob", asset: "xlm", amount: "1" }],
        assertions: [],
      };

      const result = await gateway.execute(scenario);

      expect(result.steps[0]).toMatchObject({ id: "payment", status: "passed", transactionHash: "transaction-hash" });
      expect(loadAccount).toHaveBeenCalledTimes(1);
      expect(submitTransaction).toHaveBeenCalledTimes(2);
      expect(sleep).toHaveBeenCalledExactlyOnceWith(1_000);
    });

    it("does not retry 400 client errors", async () => {
      const loadAccount = vi.spyOn(Horizon.Server.prototype, "loadAccount")
        .mockRejectedValue(horizonResponseError(400));
      const sleep = vi.fn(async (_ms: number) => {});
      const gateway = new StellarTestnetGateway("https://horizon.example", "https://friendbot.example", {
        horizonRetry: { random: () => 1 },
        sleep,
      });

      await expect(gateway.execute(accountScenario)).rejects.toMatchObject({ name: "SafeRunError" });
      expect(loadAccount).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
    });

    it("retries timeout errors and reports exhaustion after three retries", async () => {
      const timeoutError = Object.assign(new Error("request timed out"), { code: "ETIMEDOUT" });
      const loadAccount = vi.spyOn(Horizon.Server.prototype, "loadAccount").mockRejectedValue(timeoutError);
      const sleep = vi.fn(async (_ms: number) => {});
      const gateway = new StellarTestnetGateway("https://horizon.example", "https://friendbot.example", {
        horizonRetry: { random: () => 1 },
        sleep,
      });

      await expect(gateway.execute(accountScenario)).rejects.toMatchObject({
        name: "SafeRunError",
        message: "Horizon request failed after 3 retries.",
      });
      expect(loadAccount).toHaveBeenCalledTimes(4);
      expect(sleep.mock.calls.map(([delay]) => delay)).toEqual([1_000, 2_000, 4_000]);
    });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("retries on HTTP 429 and succeeds when a subsequent attempt returns 200", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 429 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));

    const gateway = new StellarTestnetGateway(
      "https://horizon-testnet.stellar.org",
      "https://friendbot.stellar.org",
      {
        fetch: fetchMock,
        friendbotRetry: {
          maxAttempts: 3,
          baseDelayMs: 1_000,
          maxDelayMs: 4_000,
          factor: 2,
          random: () => 1,
        },
      },
    );

    const promise = gateway.fundAccount(publicKey);
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries on HTTP 500/503 server errors and recovers", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));

    const gateway = new StellarTestnetGateway(
      "https://horizon-testnet.stellar.org",
      "https://friendbot.stellar.org",
      {
        fetch: fetchMock,
        friendbotRetry: {
          maxAttempts: 3,
          baseDelayMs: 500,
          random: () => 1,
        },
      },
    );

    const promise = gateway.fundAccount(publicKey);
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries on transient network failures and recovers", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError("fetch failed: ECONNRESET"))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));

    const gateway = new StellarTestnetGateway(
      "https://horizon-testnet.stellar.org",
      "https://friendbot.stellar.org",
      {
        fetch: fetchMock,
        friendbotRetry: {
          maxAttempts: 3,
          baseDelayMs: 500,
          random: () => 1,
        },
      },
    );

    const promise = gateway.fundAccount(publicKey);
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry client errors (e.g. HTTP 400) and fails immediately", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 400 }));

    const gateway = new StellarTestnetGateway(
      "https://horizon-testnet.stellar.org",
      "https://friendbot.stellar.org",
      {
        fetch: fetchMock,
        friendbotRetry: { maxAttempts: 3 },
      },
    );

    await expect(gateway.fundAccount(publicKey)).rejects.toMatchObject({
      name: "SafeRunError",
      report: {
        code: "FRIENDBOT_UNAVAILABLE",
        message: "Friendbot rejected the funding request with HTTP 400.",
        category: "network",
        retryable: false,
        failedStepId: "fund-accounts",
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("exhausts retries after maxAttempts and produces a sanitized error for server errors", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("Internal Server Error HTML Details", { status: 500 }));

    const gateway = new StellarTestnetGateway(
      "https://horizon-testnet.stellar.org",
      "https://friendbot.stellar.org",
      {
        fetch: fetchMock,
        friendbotRetry: {
          maxAttempts: 3,
          baseDelayMs: 1_000,
          factor: 2,
          random: () => 1,
        },
      },
    );

    const promise = gateway.fundAccount(publicKey).catch((err: unknown) => err);
    await vi.runAllTimersAsync();

    const error = await promise;
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(error).toBeInstanceOf(SafeRunError);
    expect((error as SafeRunError).report).toEqual({
      code: "FRIENDBOT_UNAVAILABLE",
      message: "Friendbot rejected the funding request with HTTP 500.",
      category: "network",
      retryable: true,
      failedStepId: "fund-accounts",
    });
    // Verify raw response HTML or internal details were not leaked
    expect(JSON.stringify((error as SafeRunError).report)).not.toContain("Internal Server Error HTML Details");
  });

  it("exhausts retries after maxAttempts and produces a sanitized error for network errors", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new TypeError("socket hang up"));

    const gateway = new StellarTestnetGateway(
      "https://horizon-testnet.stellar.org",
      "https://friendbot.stellar.org",
      {
        fetch: fetchMock,
        friendbotRetry: {
          maxAttempts: 3,
          baseDelayMs: 1_000,
          factor: 2,
          random: () => 1,
        },
      },
    );

    const promise = gateway.fundAccount(publicKey).catch((err: unknown) => err);
    await vi.runAllTimersAsync();

    const error = await promise;
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(error).toBeInstanceOf(SafeRunError);
    expect((error as SafeRunError).report).toEqual({
      code: "FRIENDBOT_UNAVAILABLE",
      message: "Friendbot could not be reached.",
      category: "network",
      retryable: true,
      failedStepId: "fund-accounts",
    });
    expect(JSON.stringify((error as SafeRunError).report)).not.toContain("socket hang up");
  });

  it("stops retries immediately when abort signal triggers during backoff delay", async () => {
    const controller = new AbortController();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 429 }));

    const gateway = new StellarTestnetGateway(
      "https://horizon-testnet.stellar.org",
      "https://friendbot.stellar.org",
      {
        fetch: fetchMock,
        friendbotRetry: {
          maxAttempts: 3,
          baseDelayMs: 1_000,
          random: () => 1,
        },
      },
    );

    const promise = gateway.fundAccount(publicKey, controller.signal);
    // Abort before the backoff timer elapses
    controller.abort(new Error("Run aborted by client"));
    await expect(promise).rejects.toThrow("Run aborted by client");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("stops retries immediately when signal is already aborted before request", async () => {
    const controller = new AbortController();
    controller.abort(new Error("Already aborted"));
    const fetchMock = vi.fn<typeof fetch>();

    const gateway = new StellarTestnetGateway(
      "https://horizon-testnet.stellar.org",
      "https://friendbot.stellar.org",
      { fetch: fetchMock },
    );

    await expect(gateway.fundAccount(publicKey, controller.signal)).rejects.toThrow("Already aborted");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("integrates bounded retries into scenario execution when accounts require funding", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 429 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));

    const gateway = new StellarTestnetGateway(
      "https://horizon-testnet.stellar.org",
      "https://friendbot.stellar.org",
      {
        fetch: fetchMock,
        friendbotRetry: {
          maxAttempts: 3,
          baseDelayMs: 500,
          random: () => 1,
        },
      },
    );

    const scenario: ValidatedScenario = {
      schemaVersion: 1,
      id: "funding-retry-scenario",
      version: 1,
      name: "Funding retry scenario",
      description: "Verifies scenario execution with transient friendbot failure",
      network: "testnet",
      contentHash: "sha256:abc",
      accounts: [{ id: "alice", generate: true, fund: true }],
      assets: [{ id: "xlm", type: "native" }],
      steps: [],
      assertions: [],
    };

    const promise = gateway.execute(scenario);
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.steps).toEqual([
      { id: "fund-accounts", type: "fundAccounts", status: "passed", message: "Test accounts funded." },
    ]);
  });

  it("fails the funding step and throws sanitized error when retries are exhausted during execution", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("Gateway Timeout", { status: 504 }));

    const recordedSteps: unknown[] = [];
    const gateway = new StellarTestnetGateway(
      "https://horizon-testnet.stellar.org",
      "https://friendbot.stellar.org",
      {
        fetch: fetchMock,
        friendbotRetry: {
          maxAttempts: 2,
          baseDelayMs: 250,
          random: () => 1,
        },
      },
    );

    const scenario: ValidatedScenario = {
      schemaVersion: 1,
      id: "funding-fail-scenario",
      version: 1,
      name: "Funding fail scenario",
      description: "Verifies scenario failure when friendbot retries are exhausted",
      network: "testnet",
      contentHash: "sha256:def",
      accounts: [{ id: "bob", generate: true, fund: true }],
      assets: [{ id: "xlm", type: "native" }],
      steps: [],
      assertions: [],
    };

    const promise = gateway
      .execute(scenario, { onStep: (step) => recordedSteps.push(step) })
      .catch((err: unknown) => err);
    await vi.runAllTimersAsync();
    const error = await promise;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(error).toBeInstanceOf(SafeRunError);
    expect((error as SafeRunError).report).toMatchObject({
      code: "FRIENDBOT_UNAVAILABLE",
      message: "Friendbot rejected the funding request with HTTP 504.",
      failedStepId: "fund-accounts",
      retryable: true,
    });
    expect(recordedSteps).toEqual([
      {
        id: "fund-accounts",
        type: "fundAccounts",
        status: "failed",
        message: "Friendbot rejected the funding request with HTTP 504.",
      },
    ]);
  });
});
