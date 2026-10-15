import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ScenarioDefinition } from "../src/domain.js";
import { canonicalJson, contentHash, parseScenario, prepareScenario, ScenarioRegistry } from "../src/scenario-loader.js";
import { SCENARIO_LIMITS, ScenarioValidationError } from "../src/scenario-schema.js";
import { completeScenario } from "./fixtures.js";
import { createScenarioRegistry } from "../src/scenarios.js";

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Scenario Schema v1", () => {
  it("accepts JSON and YAML with every operation and assertion type", () => {
    const definition = completeScenario();
    expect(prepareScenario(definition)).toMatchObject({ id: "complete-scenario", contentHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/) });
    const yaml = `
schemaVersion: 1
id: yaml-scenario
version: 1
name: YAML scenario
description: Parsed without executable content.
network: testnet
accounts:
  - { id: sender, generate: true, fund: true }
  - { id: recipient, generate: true, fund: true }
assets:
  - { id: xlm, type: native }
steps:
  - { id: pay, type: payment, from: sender, to: recipient, asset: xlm, amount: "1" }
assertions:
  - { type: stepSucceeded, step: pay }
`;
    expect(parseScenario(yaml, "yaml")).toMatchObject({ id: "yaml-scenario", schemaVersion: 1 });
    expect(parseScenario(JSON.stringify(definition), "json").id).toBe(definition.id);
  });

  it.each([
    ["Mainnet", (value: any) => { value.network = "mainnet"; }],
    ["secret keys", (value: any) => { value.accounts[0].secretKey = `S${"A".repeat(55)}`; }],
    ["arbitrary URLs", (value: any) => { value.steps[0].url = "https://attacker.example"; }],
    ["scripts", (value: any) => { value.steps[0].script = "process.exit()"; }],
    ["raw XDR", (value: any) => { value.steps[0].xdr = "AAAA"; }],
    ["negative amounts", (value: any) => { value.steps[1].amount = "-1"; }],
    ["excess precision", (value: any) => { value.steps[1].amount = "1.00000001"; }],
    ["amount overflow", (value: any) => { value.steps[1].amount = "999999999999"; }],
    ["unknown accounts", (value: any) => { value.steps[1].to = "nobody"; }],
    ["unknown assets", (value: any) => { value.steps[1].asset = "unknown"; }],
    ["duplicate IDs", (value: any) => { value.accounts[1].id = value.accounts[0].id; }],
    ["native trustlines", (value: any) => { value.steps[0].asset = "xlm"; }],
  ])("rejects %s", (_label, mutate) => {
    const value = structuredClone(completeScenario());
    mutate(value);
    expect(() => prepareScenario(value)).toThrow(ScenarioValidationError);
  });

  it("enforces collection and body resource limits", () => {
    const tooMany = completeScenario();
    tooMany.steps = Array.from({ length: SCENARIO_LIMITS.steps + 1 }, (_, index) => ({ id: `pay-${index}`, type: "payment" as const, from: "issuer", to: "recipient", asset: "xlm", amount: "1" }));
    expect(() => prepareScenario(tooMany)).toThrow(ScenarioValidationError);
    expect(() => parseScenario(" ".repeat(SCENARIO_LIMITS.definitionBytes + 1), "yaml")).toThrow(ScenarioValidationError);
    const oversizedObject = completeScenario() as ScenarioDefinition & { padding?: string };
    oversizedObject.padding = "x".repeat(SCENARIO_LIMITS.definitionBytes);
    expect(() => prepareScenario(oversizedObject)).toThrow(ScenarioValidationError);
  });

  it("rejects YAML aliases and duplicate keys", () => {
    const duplicate = `schemaVersion: 1\nschemaVersion: 1`;
    expect(() => parseScenario(duplicate, "yaml")).toThrow(ScenarioValidationError);
    const alias = `base: &base { id: sender }\ncopy: *base`;
    expect(() => parseScenario(alias, "yaml")).toThrow(ScenarioValidationError);
  });

  it("produces a stable hash independent of object key order", () => {
    const definition = completeScenario();
    const reordered = Object.fromEntries(Object.entries(definition).reverse()) as unknown as ScenarioDefinition;
    expect(canonicalJson(reordered)).toBe(canonicalJson(definition));
    expect(contentHash(reordered)).toBe(contentHash(definition));
  });

  it("loads a completely new external fixture without source-code registration", () => {
    const directory = mkdtempSync(join(tmpdir(), "esure-scenarios-"));
    temporaryDirectories.push(directory);
    writeFileSync(join(directory, "new-scenario.json"), JSON.stringify({ ...completeScenario(), id: "external-scenario", name: "External scenario" }));
    const registry = new ScenarioRegistry([directory]);
    expect(registry.find("external-scenario")).toMatchObject({ id: "external-scenario", name: "External scenario" });
  });

  it("loads the bundled multi-hop path payment scenario", () => {
    const scenario = createScenarioRegistry().find("path-payment");
    expect(scenario).toMatchObject({
      id: "path-payment",
      steps: expect.arrayContaining([
        expect.objectContaining({ type: "manageSellOffer" }),
        expect.objectContaining({
          type: "pathPaymentStrictReceive",
          sendAsset: "xlm",
          destAsset: "usdc",
          path: ["eur"],
        }),
      ]),
    });
    expect(scenario?.accounts).toHaveLength(4);
  });

  it("rejects unresolved or endpoint assets in path payment paths", () => {
    const scenario = createScenarioRegistry().find("path-payment")!;
    const { contentHash: _invalidHash, ...invalidReference } = structuredClone(scenario);
    const pathPayment = invalidReference.steps.find((step) => step.type === "pathPaymentStrictReceive");
    if (pathPayment?.type === "pathPaymentStrictReceive") pathPayment.path = ["unknown"];
    expect(() => prepareScenario(invalidReference)).toThrow(ScenarioValidationError);

    const { contentHash: _endpointHash, ...endpointInPath } = structuredClone(scenario);
    const payment = endpointInPath.steps.find((step) => step.type === "pathPaymentStrictReceive");
    if (payment?.type === "pathPaymentStrictReceive") payment.path = ["xlm"];
    try {
      prepareScenario(endpointInPath);
      throw new Error("Expected invalid path asset to be rejected");
    } catch (error) {
      if (!(error instanceof ScenarioValidationError)) throw error;
      expect(error.issues).toContain("step pay-usdc-through-eur path must contain only intermediate assets");
    }
  });
});
