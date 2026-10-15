import type { RunReport } from "./domain.js";
import { RunCapacityError } from "./errors.js";
import type { QueryResultRow } from "pg";
import type { Database } from "./database.js";

export interface RunStore {
  create(run: RunReport): void | Promise<void>;
  get(id: string): RunReport | undefined | Promise<RunReport | undefined>;
  update(id: string, update: Partial<RunReport>): RunReport | Promise<RunReport>;
}

export class InMemoryRunStore implements RunStore {
  readonly #runs = new Map<string, RunReport>();

  constructor(
    private readonly maxEntries = 500,
    private readonly retentionMs = 3_600_000,
    private readonly now: () => number = Date.now,
  ) {}

  get size(): number {
    this.removeExpired();
    return this.#runs.size;
  }

  create(run: RunReport): void {
    this.removeExpired();
    while (this.#runs.size >= this.maxEntries) {
      const terminal = [...this.#runs.entries()].find(([, candidate]) => isTerminal(candidate));
      if (!terminal) throw new RunCapacityError("The run store is full with active runs. Try again later.");
      this.#runs.delete(terminal[0]);
    }
    this.#runs.set(run.id, structuredClone(run));
  }

  get(id: string): RunReport | undefined {
    this.removeExpired();
    const run = this.#runs.get(id);
    return run ? structuredClone(run) : undefined;
  }

  update(id: string, update: Partial<RunReport>): RunReport {
    this.removeExpired();
    const current = this.#runs.get(id);
    if (!current) throw new Error(`Run ${id} does not exist`);
    const updated = { ...current, ...structuredClone(update) };
    this.#runs.set(id, updated);
    return structuredClone(updated);
  }

  private removeExpired(): void {
    const cutoff = this.now() - this.retentionMs;
    for (const [id, run] of this.#runs) {
      const terminalAt = run.completedAt ? Date.parse(run.completedAt) : Number.NaN;
      if (isTerminal(run) && Number.isFinite(terminalAt) && terminalAt <= cutoff) this.#runs.delete(id);
    }
  }
}

interface PersistedRunRow extends QueryResultRow {
  run_id: string;
  scenario_id: string;
  scenario_version: number;
  scenario_schema_version: 1;
  scenario_content_hash: string;
  network: "testnet";
  status: RunReport["status"];
  created_at: Date | string;
  completed_at: Date | string | null;
  steps: RunReport["steps"];
  assertions: RunReport["assertions"];
  summary: RunReport["summary"];
  error: RunReport["error"] | null;
}

export class PostgresRunStore implements RunStore {
  constructor(
    private readonly database: Database,
    private readonly retentionMs = 3_600_000,
  ) {}

  async create(run: RunReport): Promise<void> {
    const safeRun = sanitizeRunReport(run);
    await this.database.query(
      `INSERT INTO runs (
        id, run_id, scenario_id, scenario_version, scenario_schema_version,
        scenario_content_hash, scenario_version_id, network, status, created_at,
        completed_at, duration_ms, steps, assertions, summary, error
      ) VALUES ($1, $1, $2, $3, $4, $5, NULL, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb, $13::jsonb, $14::jsonb)`,
      runValues(safeRun),
    );
  }

  async get(id: string): Promise<RunReport | undefined> {
    const result = await this.database.query<PersistedRunRow>(
      `SELECT run_id, scenario_id, scenario_version, scenario_schema_version,
        scenario_content_hash, network, status, created_at, completed_at,
        steps, assertions, summary, error
      FROM runs
      WHERE run_id = $1
        AND scenario_id IS NOT NULL
        AND (completed_at IS NULL OR completed_at > clock_timestamp() - ($2 * interval '1 millisecond'))`,
      [id, this.retentionMs],
    );
    const row = result.rows[0];
    return row ? reportFromRow(row) : undefined;
  }

  async update(id: string, update: Partial<RunReport>): Promise<RunReport> {
    const current = await this.get(id);
    if (!current) throw new Error(`Run ${id} does not exist`);
    const updated = sanitizeRunReport({ ...current, ...structuredClone(update) });
    const result = await this.database.query(
      `UPDATE runs SET
        scenario_id = $2,
        scenario_version = $3,
        scenario_schema_version = $4,
        scenario_content_hash = $5,
        network = $6,
        status = $7,
        created_at = $8,
        completed_at = $9,
        duration_ms = $10,
        steps = $11::jsonb,
        assertions = $12::jsonb,
        summary = $13::jsonb,
        error = $14::jsonb
      WHERE run_id = $1
        AND (completed_at IS NULL OR completed_at > clock_timestamp() - ($15 * interval '1 millisecond'))`,
      [id, ...runValues(updated).slice(1), this.retentionMs],
    );
    if (result.rowCount !== 1) throw new Error(`Run ${id} does not exist`);
    return structuredClone(updated);
  }
}

function runValues(run: RunReport): unknown[] {
  return [
    run.id,
    run.scenarioId,
    run.scenarioVersion,
    run.scenarioSchemaVersion,
    run.scenarioContentHash,
    run.network,
    run.status,
    run.createdAt,
    run.completedAt ?? null,
    run.completedAt ? Math.max(0, Date.parse(run.completedAt) - Date.parse(run.createdAt)) : null,
    JSON.stringify(run.steps),
    JSON.stringify(run.assertions),
    JSON.stringify(run.summary),
    JSON.stringify(run.error ?? null),
  ];
}

function reportFromRow(row: PersistedRunRow): RunReport {
  return sanitizeRunReport({
    id: row.run_id,
    scenarioId: row.scenario_id,
    scenarioVersion: row.scenario_version,
    scenarioSchemaVersion: row.scenario_schema_version,
    scenarioContentHash: row.scenario_content_hash,
    network: row.network,
    status: row.status,
    createdAt: new Date(row.created_at).toISOString(),
    ...(row.completed_at && { completedAt: new Date(row.completed_at).toISOString() }),
    steps: row.steps,
    assertions: row.assertions,
    summary: row.summary,
    ...(row.error && { error: row.error }),
  });
}

function sanitizeRunReport(run: RunReport): RunReport {
  return {
    ...run,
    id: redactAccountMaterial(run.id),
    scenarioId: redactAccountMaterial(run.scenarioId),
    scenarioContentHash: redactAccountMaterial(run.scenarioContentHash),
    steps: run.steps.map((step) => ({
      id: redactAccountMaterial(step.id),
      type: redactAccountMaterial(step.type),
      status: step.status,
      ...(step.transactionHash && { transactionHash: redactAccountMaterial(step.transactionHash) }),
      ...(step.ledger !== undefined && { ledger: step.ledger }),
      ...(step.stellarTransactionCode && { stellarTransactionCode: redactAccountMaterial(step.stellarTransactionCode) }),
      ...(step.stellarOperationCodes && { stellarOperationCodes: step.stellarOperationCodes.map(redactAccountMaterial) }),
      message: redactAccountMaterial(step.message),
    })),
    assertions: run.assertions.map((assertion) => ({
      type: assertion.type,
      status: assertion.status,
      expected: sanitizeAssertionValue(assertion.expected),
      actual: sanitizeAssertionValue(assertion.actual),
      message: redactAccountMaterial(assertion.message),
    })),
    ...(run.error && {
      error: {
        code: redactAccountMaterial(run.error.code),
        message: redactAccountMaterial(run.error.message),
        category: run.error.category,
        retryable: run.error.retryable,
        ...(run.error.failedStepId && { failedStepId: redactAccountMaterial(run.error.failedStepId) }),
        ...(run.error.stellarTransactionCode && { stellarTransactionCode: redactAccountMaterial(run.error.stellarTransactionCode) }),
        ...(run.error.stellarOperationCodes && { stellarOperationCodes: run.error.stellarOperationCodes.map(redactAccountMaterial) }),
      },
    }),
  };
}

function sanitizeAssertionValue(value: RunReport["assertions"][number]["expected"]): typeof value {
  if (typeof value === "string") return redactAccountMaterial(value);
  if (Array.isArray(value)) return value.map(sanitizeUnknownAssertionValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !isSensitiveReportKey(key))
      .map(([key, item]) => [redactAccountMaterial(key), sanitizeUnknownAssertionValue(item)]));
  }
  return value;
}

function sanitizeUnknownAssertionValue(value: unknown): unknown {
  if (typeof value === "string") return redactAccountMaterial(value);
  if (Array.isArray(value)) return value.map(sanitizeUnknownAssertionValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !isSensitiveReportKey(key))
      .map(([key, item]) => [redactAccountMaterial(key), sanitizeUnknownAssertionValue(item)]));
  }
  return value;
}

function isSensitiveReportKey(key: string): boolean {
  return /^(?:secret|secretseed|seed|secretkey|accountkey|publickey|privatekey|signedxdr|xdr)$/.test(key.replace(/[_-]/g, "").toLowerCase());
}

function redactAccountMaterial(value: string): string {
  return value.replace(/[SG][A-Z2-7]{55}/g, "[REDACTED]");
}

function isTerminal(run: RunReport): boolean {
  return run.status === "passed" || run.status === "failed";
}
