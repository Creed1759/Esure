import { Ajv, type ErrorObject } from "ajv";
import type { ScenarioAssertion, ScenarioDefinition } from "./domain.js";

export const SCENARIO_LIMITS = {
  accounts: 10,
  assets: 10,
  steps: 20,
  assertions: 20,
  definitionBytes: 16_384,
} as const;

const id = { type: "string", pattern: "^[a-z][a-z0-9-]{0,63}$", maxLength: 64 } as const;
const amount = { type: "string", pattern: "^(?:0|[1-9][0-9]{0,11})(?:\\.[0-9]{1,7})?$", maxLength: 20 } as const;
const positiveAmount = { ...amount, not: { pattern: "^0(?:\\.0+)?$" } } as const;
const signedAmount = { type: "string", pattern: "^-?(?:0|[1-9][0-9]{0,11})(?:\\.[0-9]{1,7})?$", maxLength: 21 } as const;
const code = { type: "string", pattern: "^[A-Z0-9]{1,12}$", maxLength: 12 } as const;
const resultCode = { type: "string", pattern: "^[a-z][a-z0-9_]{0,63}$", maxLength: 64 } as const;

export const scenarioSchemaV1 = {
  $id: "https://esure.dev/schemas/scenario-v1.json",
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "id", "version", "name", "description", "network", "accounts", "assets", "steps", "assertions"],
  properties: {
    schemaVersion: { const: 1 },
    id,
    version: { type: "integer", minimum: 1, maximum: 2_147_483_647 },
    name: { type: "string", minLength: 1, maxLength: 120 },
    description: { type: "string", minLength: 1, maxLength: 500 },
    network: { const: "testnet" },
    accounts: {
      type: "array", minItems: 1, maxItems: SCENARIO_LIMITS.accounts,
      items: { type: "object", additionalProperties: false, required: ["id", "generate", "fund"], properties: { id, generate: { const: true }, fund: { type: "boolean" } } },
    },
    assets: {
      type: "array", minItems: 1, maxItems: SCENARIO_LIMITS.assets,
      items: { oneOf: [
        { type: "object", additionalProperties: false, required: ["id", "type"], properties: { id, type: { const: "native" } } },
        { type: "object", additionalProperties: false, required: ["id", "type", "code", "issuer"], properties: { id, type: { const: "issued" }, code, issuer: id } },
      ] },
    },
    steps: {
      type: "array", minItems: 0, maxItems: SCENARIO_LIMITS.steps,
      items: { oneOf: [
        { type: "object", additionalProperties: false, required: ["id", "type", "account", "asset"], properties: { id, type: { const: "changeTrust" }, account: id, asset: id, limit: positiveAmount } },
        { type: "object", additionalProperties: false, required: ["id", "type", "from", "to", "asset", "amount"], properties: { id, type: { const: "payment" }, from: id, to: id, asset: id, amount: positiveAmount } },
        { type: "object", additionalProperties: false, required: ["id", "type", "account", "sellingAsset", "buyingAsset", "amount", "price"], properties: { id, type: { const: "manageSellOffer" }, account: id, sellingAsset: id, buyingAsset: id, amount: positiveAmount, price: positiveAmount } },
        { type: "object", additionalProperties: false, required: ["id", "type", "from", "to", "sendAsset", "sendMax", "destAsset", "destAmount", "path"], properties: { id, type: { const: "pathPaymentStrictReceive" }, from: id, to: id, sendAsset: id, sendMax: positiveAmount, destAsset: id, destAmount: positiveAmount, path: { type: "array", maxItems: 5, items: id } } },
        { type: "object", additionalProperties: false, required: ["id", "type", "from", "to", "sendAsset", "sendAmount", "destAsset", "destMin", "path"], properties: { id, type: { const: "pathPaymentStrictSend" }, from: id, to: id, sendAsset: id, sendAmount: positiveAmount, destAsset: id, destMin: positiveAmount, path: { type: "array", maxItems: 5, items: id } } },
      ] },
    },
    assertions: {
      type: "array", minItems: 1, maxItems: SCENARIO_LIMITS.assertions,
      items: { oneOf: [
        { type: "object", additionalProperties: false, required: ["type", "account", "asset", "amount"], properties: { type: { const: "balanceEquals" }, account: id, asset: id, amount } },
        { type: "object", additionalProperties: false, required: ["type", "account", "asset", "amount"], properties: { type: { const: "balanceChangedBy" }, account: id, asset: id, amount: signedAmount } },
        { type: "object", additionalProperties: false, required: ["type", "step"], properties: { type: { enum: ["stepSucceeded", "transactionConfirmed"] }, step: id } },
        { type: "object", additionalProperties: false, required: ["type", "step", "transactionCode", "operationCodes"], properties: { type: { const: "stepFailedWith" }, step: id, transactionCode: resultCode, operationCodes: { type: "array", minItems: 0, maxItems: 100, items: resultCode } } },
        { type: "object", additionalProperties: false, required: ["type", "account", "asset"], properties: { type: { enum: ["trustlineExists", "trustlineMissing"] }, account: id, asset: id } },
        { type: "object", additionalProperties: false, required: ["type", "account"], properties: { type: { const: "accountExists" }, account: id } },
      ] },
    },
  },
} as const;

const ajv = new Ajv({ allErrors: true, strict: true });
const validateSchema = ajv.compile<ScenarioDefinition>(scenarioSchemaV1);

export class ScenarioValidationError extends Error {
  constructor(readonly issues: string[]) {
    super("Scenario definition is invalid.");
    this.name = "ScenarioValidationError";
  }
}

export function validateScenarioDefinition(value: unknown): ScenarioDefinition {
  validateSafeValues(value);
  if (!validateSchema(value)) throw new ScenarioValidationError(formatAjvErrors(validateSchema.errors));
  validateReferences(value);
  validateAmounts(value);
  return structuredClone(value);
}

function validateSafeValues(value: unknown): void {
  const issues: string[] = [];
  const visit = (item: unknown, path: string): void => {
    if (typeof item === "string") {
      if (/S[A-Z2-7]{55}/.test(item)) issues.push(`${path} must not contain a Stellar secret seed`);
      if (/\b(?:https?|ftp|file):\/\//i.test(item)) issues.push(`${path} must not contain a URL`);
      return;
    }
    if (Array.isArray(item)) { item.forEach((child, index) => visit(child, `${path}/${index}`)); return; }
    if (item && typeof item === "object") {
      for (const [key, child] of Object.entries(item as Record<string, unknown>)) {
        if (/^(?:secret|secretKey|seed|script|code|url|uri|xdr|envelope)$/i.test(key) && key !== "code") issues.push(`${path}/${key} is forbidden`);
        visit(child, `${path}/${key}`);
      }
    }
  };
  visit(value, "");
  if (issues.length) throw new ScenarioValidationError(issues);
}

function validateAmounts(scenario: ScenarioDefinition): void {
  const maximumStroops = 9_223_372_036_854_775_807n;
  const issues: string[] = [];
  const values: Array<[string, string]> = [];
  for (const step of scenario.steps) {
    if ("amount" in step) values.push([`step ${step.id} amount`, step.amount]);
    if ("limit" in step && step.limit) values.push([`step ${step.id} limit`, step.limit]);
    if (step.type === "manageSellOffer") values.push([`step ${step.id} price`, step.price]);
    if (step.type === "pathPaymentStrictReceive") values.push([`step ${step.id} sendMax`, step.sendMax], [`step ${step.id} destAmount`, step.destAmount]);
    if (step.type === "pathPaymentStrictSend") values.push([`step ${step.id} sendAmount`, step.sendAmount], [`step ${step.id} destMin`, step.destMin]);
  }
  for (const assertion of scenario.assertions) if ("amount" in assertion) values.push([`assertion ${assertion.type} amount`, assertion.amount]);
  for (const [label, value] of values) {
    const absolute = value.startsWith("-") ? value.slice(1) : value;
    const [integer = "0", fraction = ""] = absolute.split(".");
    const stroops = BigInt(integer) * 10_000_000n + BigInt(fraction.padEnd(7, "0"));
    if (stroops > maximumStroops) issues.push(`${label} exceeds Stellar's signed 64-bit amount limit`);
  }
  if (issues.length) throw new ScenarioValidationError(issues);
}

function validateReferences(scenario: ScenarioDefinition): void {
  const issues: string[] = [];
  const accounts = uniqueIds(scenario.accounts, "accounts", issues);
  const assets = uniqueIds(scenario.assets, "assets", issues);
  const steps = uniqueIds(scenario.steps, "steps", issues);

  const nativeAssets = scenario.assets.filter((asset) => asset.type === "native");
  if (nativeAssets.length !== 1) issues.push("assets must contain exactly one native asset");
  for (const asset of scenario.assets) {
    if (asset.type === "issued" && !accounts.has(asset.issuer)) issues.push(`asset ${asset.id} references unknown issuer ${asset.issuer}`);
  }
  for (const step of scenario.steps) {
    if (step.type === "changeTrust") {
      if (!accounts.has(step.account)) issues.push(`step ${step.id} references unknown account ${step.account}`);
      if (!assets.has(step.asset)) issues.push(`step ${step.id} references unknown asset ${step.asset}`);
      else if (scenario.assets.find((candidate) => candidate.id === step.asset)?.type === "native") issues.push(`step ${step.id} cannot create a trustline for native XLM`);
    } else if (step.type === "payment") {
      if (!accounts.has(step.from)) issues.push(`step ${step.id} references unknown source account ${step.from}`);
      if (!accounts.has(step.to)) issues.push(`step ${step.id} references unknown destination account ${step.to}`);
      if (!assets.has(step.asset)) issues.push(`step ${step.id} references unknown asset ${step.asset}`);
    } else if (step.type === "manageSellOffer") {
      if (!accounts.has(step.account)) issues.push(`step ${step.id} references unknown account ${step.account}`);
      if (!assets.has(step.sellingAsset)) issues.push(`step ${step.id} references unknown selling asset ${step.sellingAsset}`);
      if (!assets.has(step.buyingAsset)) issues.push(`step ${step.id} references unknown buying asset ${step.buyingAsset}`);
      if (step.sellingAsset === step.buyingAsset) issues.push(`step ${step.id} must sell and buy different assets`);
    } else {
      if (!accounts.has(step.from)) issues.push(`step ${step.id} references unknown source account ${step.from}`);
      if (!accounts.has(step.to)) issues.push(`step ${step.id} references unknown destination account ${step.to}`);
      const sendAsset = scenario.assets.find((asset) => asset.id === step.sendAsset);
      const destAsset = scenario.assets.find((asset) => asset.id === step.destAsset);
      if (!sendAsset) issues.push(`step ${step.id} references unknown send asset ${step.sendAsset}`);
      if (!destAsset) issues.push(`step ${step.id} references unknown destination asset ${step.destAsset}`);
      if (step.sendAsset === step.destAsset) issues.push(`step ${step.id} must send and receive different assets`);
      if (new Set(step.path).size !== step.path.length) issues.push(`step ${step.id} path contains duplicate assets`);
      for (const assetId of step.path) {
        if (!assets.has(assetId)) issues.push(`step ${step.id} references unknown path asset ${assetId}`);
        if (assetId === step.sendAsset || assetId === step.destAsset) issues.push(`step ${step.id} path must contain only intermediate assets`);
      }
    }
  }
  for (const assertion of scenario.assertions) validateAssertionReferences(assertion, accounts, assets, steps, scenario, issues);
  if (issues.length) throw new ScenarioValidationError(issues);
}

function validateAssertionReferences(assertion: ScenarioAssertion, accounts: Set<string>, assets: Set<string>, steps: Set<string>, scenario: ScenarioDefinition, issues: string[]): void {
  if ("account" in assertion && !accounts.has(assertion.account)) issues.push(`assertion ${assertion.type} references unknown account ${assertion.account}`);
  if ("asset" in assertion && !assets.has(assertion.asset)) issues.push(`assertion ${assertion.type} references unknown asset ${assertion.asset}`);
  if ("step" in assertion && !steps.has(assertion.step)) issues.push(`assertion ${assertion.type} references unknown step ${assertion.step}`);
  if ((assertion.type === "trustlineExists" || assertion.type === "trustlineMissing") && scenario.assets.find((asset) => asset.id === assertion.asset)?.type === "native") {
    issues.push(`assertion ${assertion.type} cannot target native XLM`);
  }
}

function uniqueIds(items: readonly { id: string }[], label: string, issues: string[]): Set<string> {
  const ids = new Set<string>();
  for (const item of items) {
    if (ids.has(item.id)) issues.push(`${label} contains duplicate id ${item.id}`);
    ids.add(item.id);
  }
  return ids;
}

function formatAjvErrors(errors: ErrorObject[] | null | undefined): string[] {
  return (errors ?? []).slice(0, 50).map((error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`);
}
