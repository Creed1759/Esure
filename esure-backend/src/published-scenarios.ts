import { stringify as stringifyYaml } from "yaml";
import type { ScenarioDefinition, ScenarioSummary, ValidatedScenario } from "./domain.js";
import type { Database, Queryable } from "./database.js";
import { canonicalJson, contentHash, deriveCategories, prepareScenario, type ScenarioRegistry } from "./scenario-loader.js";
import { validateScenarioDefinition } from "./scenario-schema.js";

export interface ScenarioVersionSummary {
  version: number;
  schemaVersion: 1;
  contentHash: string;
  createdAt: string;
}

/**
 * Issue #81: thrown by hydrate() when a persisted scenario_versions row
 * fails re-verification (schema validation or a recomputed content hash /
 * version mismatch) before being exposed for execution. The message is
 * intentionally generic — no row contents, hashes, or identifiers are
 * included — so it is safe to surface directly to API clients.
 *
 * Operator recovery path: this error means the specific scenario_versions
 * row backing the request is no longer trustworthy (for example, it was
 * edited outside the normal reconciliation path, or its JSON payload was
 * corrupted at rest). Do not patch the row in place — rows are immutable
 * by design (see migrations/002_scenario_catalogue.sql) and silently
 * rewriting one would hide the underlying cause. Instead: identify the
 * affected scenario_id/version_number pair, compare the stored definition
 * against the bundled fixture (or an audited backup) to confirm it is
 * actually corrupt, and remove it through the audited maintenance path
 * (esure_maintenance role + cleanup_audit, see database/bootstrap-roles.sql)
 * so reconciliation can re-publish a clean version from the bundled
 * fixture on the next run.
 */
export class ScenarioIntegrityError extends Error {
  constructor() {
    super("Published scenario catalogue failed an integrity check.");
    this.name = "ScenarioIntegrityError";
  }
}

/** Issue #80: one scenario's predicted outcome from a dry-run reconciliation. */
export interface FixtureDryRunEntry {
  id: string;
  /** "unchanged": no version would be written. "new"/"changed": reconciliation would insert a new version. */
  status: "unchanged" | "new" | "changed";
  currentVersion?: number;
  proposedVersion: number;
}

/** Issue #80: machine- and human-readable summary of a dry-run reconciliation. */
export interface FixtureDryRunReport {
  generatedAt: string;
  entries: FixtureDryRunEntry[];
  summary: { unchanged: number; new: number; changed: number };
}

interface VersionRow {
  version_number: number;
  schema_version: 1;
  content_hash: string;
  definition: ValidatedScenario;
  created_at: Date | string;
}

export class PublishedScenarioRepository {
  constructor(private readonly database: Database) {}

  async reconcile(registry: ScenarioRegistry): Promise<void> {
    for (const summary of registry.list()) {
      const fixture = registry.find(summary.id);
      if (fixture) await this.database.transaction((client) => reconcileFixture(client, fixture));
    }
  }

  /**
   * Issue #80: preview what `reconcile()` would do without writing
   * anything. Uses the exact same version-insensitive comparison
   * (`comparable()`) as real reconciliation, so predictions here are
   * guaranteed to match a subsequent real run as long as the catalogue
   * and bundled fixtures have not changed in between.
   */
  async dryRunReconcile(registry: ScenarioRegistry): Promise<FixtureDryRunReport> {
    const entries: FixtureDryRunEntry[] = [];
    for (const summary of registry.list()) {
      const fixture = registry.find(summary.id);
      if (fixture) entries.push(await previewFixture(this.database, fixture));
    }
    return {
      generatedAt: new Date().toISOString(),
      entries,
      summary: {
        unchanged: entries.filter((entry) => entry.status === "unchanged").length,
        new: entries.filter((entry) => entry.status === "new").length,
        changed: entries.filter((entry) => entry.status === "changed").length,
      },
    };
  }

  async list(): Promise<ScenarioSummary[]> {
    const result = await this.database.query<VersionRow & { public_slug: string }>(`SELECT
      s.public_slug, sv.version_number, sv.content_hash, sv.definition, sv.schema_version, sv.created_at
      FROM scenarios s JOIN LATERAL (
        SELECT version_number, content_hash, definition, schema_version, created_at
        FROM scenario_versions WHERE scenario_id = s.id ORDER BY version_number DESC LIMIT 1
      ) sv ON true
      WHERE s.visibility = 'published' AND s.status = 'active'
      ORDER BY s.public_slug`);
    return result.rows.map((row) => ({ id: row.public_slug, version: row.version_number, name: row.definition.name, description: row.definition.description, contentHash: row.content_hash, categories: deriveCategories(row.definition) }));
  }

  async latest(slug: string): Promise<ValidatedScenario | undefined> {
    const result = await this.database.query<VersionRow>(`${versionSelect} WHERE s.public_slug = $1 AND s.visibility = 'published' AND s.status = 'active' ORDER BY sv.version_number DESC LIMIT 1`, [slug]);
    return hydrate(result.rows[0]);
  }

  async version(slug: string, version: number): Promise<ValidatedScenario | undefined> {
    const result = await this.database.query<VersionRow>(`${versionSelect} WHERE s.public_slug = $1 AND s.visibility = 'published' AND sv.version_number = $2`, [slug, version]);
    return hydrate(result.rows[0]);
  }

  async history(slug: string, limit: number, cursor?: number): Promise<{ items: ScenarioVersionSummary[]; nextCursor?: number }> {
    const values: unknown[] = [slug, limit + 1];
    const cursorClause = cursor === undefined ? "" : "AND sv.version_number < $3";
    if (cursor !== undefined) values.push(cursor);
    const result = await this.database.query<VersionRow>(`${versionSelect} WHERE s.public_slug = $1 AND s.visibility = 'published' ${cursorClause} ORDER BY sv.version_number DESC LIMIT $2`, values);
    const hasMore = result.rows.length > limit;
    const rows = result.rows.slice(0, limit);
    const items = rows.map((row) => ({ version: row.version_number, schemaVersion: row.schema_version, contentHash: row.content_hash, createdAt: new Date(row.created_at).toISOString() }));
    return { items, ...(hasMore && items.length ? { nextCursor: items[items.length - 1]!.version } : {}) };
  }

  async export(slug: string, version: number, format: "json" | "yaml"): Promise<string | undefined> {
    const scenario = await this.version(slug, version);
    if (!scenario) return undefined;
    const { contentHash: _contentHash, ...definition } = scenario;
    return format === "json" ? `${JSON.stringify(definition, null, 2)}\n` : stringifyYaml(definition, { sortMapEntries: true });
  }
}

const versionSelect = `SELECT sv.version_number, sv.schema_version, sv.content_hash, sv.definition, sv.created_at
  FROM scenarios s JOIN scenario_versions sv ON sv.scenario_id = s.id`;

export async function reconcileFixture(client: Queryable, fixture: ValidatedScenario): Promise<void> {
  const scenario = await client.query<{ id: string }>(`INSERT INTO scenarios(public_slug, origin, visibility, status)
    VALUES ($1, 'bundled', 'published', 'active')
    ON CONFLICT (public_slug) DO UPDATE SET public_slug = EXCLUDED.public_slug
    WHERE scenarios.origin = 'bundled'
    RETURNING id`, [fixture.id]);
  if (!scenario.rowCount) throw new Error("Published scenario identity belongs to a different origin");
  const scenarioId = scenario.rows[0]!.id;
  await client.query("SELECT id FROM scenarios WHERE id = $1 FOR UPDATE", [scenarioId]);
  const latest = await client.query<VersionRow>("SELECT version_number, schema_version, content_hash, definition, created_at FROM scenario_versions WHERE scenario_id = $1 ORDER BY version_number DESC LIMIT 1", [scenarioId]);
  const existing = latest.rows[0];
  if (existing && comparable(existing.definition) === comparable(fixture)) return;
  const version = (existing?.version_number ?? 0) + 1;
  const candidate = prepareScenario({ ...stripHash(fixture), version });
  await client.query(`INSERT INTO scenario_versions(scenario_id, version_number, schema_version, content_hash, definition, source_format)
    VALUES ($1, $2, $3, $4, $5::jsonb, 'json') ON CONFLICT (scenario_id, content_hash) DO NOTHING`,
  [scenarioId, version, candidate.schemaVersion, candidate.contentHash, JSON.stringify(stripHash(candidate))]);
}

/**
 * Issue #80: read-only counterpart to reconcileFixture(). Performs no
 * writes and takes no row lock — it only reports what reconciliation
 * would do, using the identical comparable() rule so dry-run predictions
 * and real reconciliation outcomes never diverge for the same inputs.
 */
export async function previewFixture(client: Queryable, fixture: ValidatedScenario): Promise<FixtureDryRunEntry> {
  const scenario = await client.query<{ id: string }>(
    "SELECT id FROM scenarios WHERE public_slug = $1 AND origin = 'bundled'",
    [fixture.id],
  );
  if (!scenario.rowCount) return { id: fixture.id, status: "new", proposedVersion: 1 };
  const scenarioId = scenario.rows[0]!.id;
  const latest = await client.query<VersionRow>(
    "SELECT version_number, schema_version, content_hash, definition, created_at FROM scenario_versions WHERE scenario_id = $1 ORDER BY version_number DESC LIMIT 1",
    [scenarioId],
  );
  const existing = latest.rows[0];
  if (existing && comparable(existing.definition) === comparable(fixture)) {
    return { id: fixture.id, status: "unchanged", currentVersion: existing.version_number, proposedVersion: existing.version_number };
  }
  return {
    id: fixture.id,
    status: existing ? "changed" : "new",
    ...(existing && { currentVersion: existing.version_number }),
    proposedVersion: (existing?.version_number ?? 0) + 1,
  };
}

function comparable(value: ValidatedScenario): string {
  const definition = stripHash(value) as Record<string, unknown>;
  delete definition.version;
  return canonicalJson(definition);
}

function stripHash(value: ValidatedScenario): Omit<ValidatedScenario, "contentHash"> {
  const { contentHash: _contentHash, ...definition } = value;
  return structuredClone(definition);
}

function hydrate(row: VersionRow | undefined): ValidatedScenario | undefined {
  return row ? verifyIntegrity(row) : undefined;
}

/**
 * Issue #81: verify a persisted row's canonical identity before exposing
 * it for execution. Previously hydrate() trusted the stored
 * definition/version/content-hash tuple as internally consistent without
 * recomputing anything. This re-validates the stored definition against
 * the canonical scenario schema and recomputes its content hash; any
 * mismatch is rejected with ScenarioIntegrityError rather than being
 * passed through to a caller (and, eventually, the ledger gateway).
 */
function verifyIntegrity(row: VersionRow): ValidatedScenario {
  let validated: ScenarioDefinition;
  try {
    validated = validateScenarioDefinition(row.definition);
  } catch {
    throw new ScenarioIntegrityError();
  }
  if (validated.version !== row.version_number || contentHash(validated) !== row.content_hash) {
    throw new ScenarioIntegrityError();
  }
  return { ...validated, contentHash: row.content_hash };
}
