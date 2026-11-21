import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import type { ScenarioCategory, ScenarioDefinition, ScenarioSummary, ValidatedScenario } from "./domain.js";
import { SCENARIO_LIMITS, ScenarioValidationError, validateScenarioDefinition } from "./scenario-schema.js";

const extensions = new Set([".json", ".yaml", ".yml"]);

export function parseScenario(source: string, format: "json" | "yaml"): ValidatedScenario {
  if (Buffer.byteLength(source, "utf8") > SCENARIO_LIMITS.definitionBytes) {
    throw new ScenarioValidationError([`definition exceeds ${SCENARIO_LIMITS.definitionBytes} bytes`]);
  }
  let parsed: unknown;
  try {
    parsed = format === "json"
      ? JSON.parse(source)
      : parseYaml(source, { maxAliasCount: 0, uniqueKeys: true, prettyErrors: false });
  } catch {
    throw new ScenarioValidationError([`definition is not valid ${format.toUpperCase()}`]);
  }
  return prepareScenario(parsed);
}

export function prepareScenario(value: unknown): ValidatedScenario {
  // #228: undefined, functions, and symbols stringify to undefined (not a
  // string), which would cause Buffer.byteLength to throw before the catch
  // below. Cyclic objects throw inside JSON.stringify. All of these must
  // produce a ScenarioValidationError rather than an unhandled crash.
  if (value === undefined || typeof value === "function" || typeof value === "symbol") {
    throw new ScenarioValidationError(["definition must be JSON-serializable"]);
  }
  let serialized: string;
  try {
    const result = JSON.stringify(value);
    // JSON.stringify returns undefined for the types above, but the guard
    // above already covers them. This handles any other non-string result.
    if (typeof result !== "string") throw new Error("non-string result");
    serialized = result;
  } catch {
    throw new ScenarioValidationError(["definition must be JSON-serializable"]);
  }
  if (Buffer.byteLength(serialized, "utf8") > SCENARIO_LIMITS.definitionBytes) {
    throw new ScenarioValidationError([`definition exceeds ${SCENARIO_LIMITS.definitionBytes} bytes`]);
  }
  const definition = validateScenarioDefinition(value);
  return { ...definition, contentHash: contentHash(definition) };
}

export function contentHash(definition: ScenarioDefinition): string {
  return `sha256:${createHash("sha256").update(canonicalJson(definition)).digest("hex")}`;
}

/**
 * Produce a deterministic canonical JSON string with object keys sorted by
 * Unicode code-unit order (i.e. the same ordering as the `<` / `>` operators
 * on strings). Using a plain comparator instead of `localeCompare` makes the
 * ordering independent of the host locale and ICU collation data, which means
 * the same input always produces the same bytes regardless of the environment
 * in which the process runs. This is the ordering contract for all content
 * hashes produced by this module (issue #87).
 *
 * Compatibility note: the Unicode code-unit ordering used here matches the
 * ordering that `localeCompare` produces under the `"en"` locale for all
 * ASCII characters (the only characters that appear in scenario field names
 * and identifiers), so existing stored hashes are unaffected.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * Derive a bounded set of categories from a validated scenario's steps and
 * assertions. The categories describe what operations the scenario exercises
 * without requiring callers to inspect individual step or assertion types.
 * Dashboard clients can use these for category-based filtering (issue #230).
 *
 * Catalogue ordering: filename (registry) and public_slug (database query)
 * both use Unicode code-unit order, matching canonicalJson and contentHash
 * ordering (issue #229).
 */
export function deriveCategories(definition: Pick<ScenarioDefinition, "steps" | "assertions">): ScenarioCategory[] {
  const categories = new Set<ScenarioCategory>();
  for (const step of definition.steps) {
    if (step.type === "payment") categories.add("payment");
    else if (step.type === "changeTrust") categories.add("trust");
    else if (step.type === "manageSellOffer") categories.add("offer");
    else if (step.type === "pathPaymentStrictReceive" || step.type === "pathPaymentStrictSend") categories.add("path-payment");
  }
  for (const assertion of definition.assertions) {
    if (assertion.type === "stepFailedWith") categories.add("failure-assertion");
  }
  // Return in a fixed order so the array is stable across calls.
  const order: ScenarioCategory[] = ["payment", "trust", "offer", "path-payment", "failure-assertion"];
  return order.filter((c) => categories.has(c));
}

export class ScenarioRegistry {
  readonly #scenarios = new Map<string, ValidatedScenario>();

  constructor(directories: string[]) {
    for (const directory of directories) this.loadDirectory(directory);
  }

  list(): ScenarioSummary[] {
    return [...this.#scenarios.values()].map(({ id, version, name, description, contentHash, steps, assertions }) => ({
      id, version, name, description, contentHash, categories: deriveCategories({ steps, assertions }),
    }));
  }

  find(id: string): ValidatedScenario | undefined {
    const found = this.#scenarios.get(id);
    return found ? structuredClone(found) : undefined;
  }

  private loadDirectory(directory: string): void {
    const absolute = resolve(directory);
    const files = readdirSync(absolute, { withFileTypes: true })
      .filter((entry) => entry.isFile() && extensions.has(extname(entry.name).toLowerCase()))
      .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    if (files.length > 100) throw new ScenarioValidationError([`scenario directory ${absolute} exceeds 100 files`]);
    for (const file of files) {
      const extension = extname(file.name).toLowerCase();
      const path = resolve(absolute, file.name);
      if (statSync(path).size > SCENARIO_LIMITS.definitionBytes) throw new ScenarioValidationError([`definition ${file.name} exceeds ${SCENARIO_LIMITS.definitionBytes} bytes`]);
      const scenario = parseScenario(readFileSync(path, "utf8"), extension === ".json" ? "json" : "yaml");
      if (this.#scenarios.has(scenario.id)) throw new ScenarioValidationError([`duplicate scenario id ${scenario.id}`]);
      this.#scenarios.set(scenario.id, scenario);
    }
  }
}
