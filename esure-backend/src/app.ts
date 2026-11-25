import { createHash } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
export type AppInstance = FastifyInstance & { runs: RunService };

export async function closeAfterDrain(app: { close: () => Promise<void>; runs: Pick<AppInstance["runs"], "drain"> }, timeoutMs: number): Promise<void> {
  const draining = app.runs.drain();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
    timer.unref();
  });
  try {
    await Promise.race([draining, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
  await app.close();
}
import type { AppConfig } from "./config.js";
import type { LedgerGateway, RunReport, ValidatedScenario } from "./domain.js";
import { RunCapacityError, RunDrainingError } from "./errors.js";
import { DatabaseUnavailableError } from "./database.js";
import { openApiDocument } from "./openapi.js";
import { FixedWindowRateLimiter } from "./rate-limiter.js";
import { RunService, type RunLifecycleLogger } from "./run-service.js";
import { InMemoryRunStore } from "./run-store.js";
import { parseScenario, prepareScenario, canonicalJson } from "./scenario-loader.js";
import { scenarioSchemaV1, ScenarioValidationError } from "./scenario-schema.js";
import { runReportSchemaV1 } from "./report-schema.js";
import { createScenarioRegistry } from "./scenarios.js";
import { StellarTestnetGateway } from "./stellar-gateway.js";
import { PersistenceCoordinator } from "./persistence.js";
import { ScenarioIntegrityError } from "./published-scenarios.js";
import { IdempotencyStore } from "./idempotency-store.js";

interface BuildAppOptions { config: AppConfig; ledger?: LedgerGateway; logger?: boolean; runLogger?: RunLifecycleLogger; clock?: () => number; }

const runBodySchema = {
  type: "object", additionalProperties: false, required: ["scenarioId"],
  properties: {
    scenarioId: { type: "string", minLength: 1, maxLength: 64, pattern: "^[a-z0-9-]+$" },
    scenarioVersion: { type: "integer", minimum: 1, maximum: 2_147_483_647 },
    inputs: { type: "object", additionalProperties: false, default: {} },
  },
} as const;

const scenarioIdParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["scenarioId"],
  properties: { scenarioId: { type: "string", minLength: 1, maxLength: 64, pattern: "^[a-z0-9-]+$" } },
} as const;

/**
 * Params schema for run routes that accept a runId path parameter.
 * Validates UUID v4 format before hitting the store, returning a stable 400
 * instead of letting PostgreSQL reject the value mid-query. Issue #220.
 */
const runIdParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["runId"],
  properties: {
    runId: {
      type: "string",
      minLength: 36,
      maxLength: 36,
      pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
    },
  },
} as const;

const versionParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["scenarioId", "version"],
  properties: {
    scenarioId: { type: "string", minLength: 1, maxLength: 64, pattern: "^[a-z0-9-]+$" },
    version: { type: "string", minLength: 1, maxLength: 10, pattern: "^[1-9][0-9]*$" },
  },
} as const;

const historyQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    limit: { type: "string", minLength: 1, maxLength: 3, pattern: "^[0-9]+$" },
    cursor: { type: "string", minLength: 1, maxLength: 10, pattern: "^[0-9]+$" },
  },
} as const;

const exportQuerySchema = {
  type: "object",
  additionalProperties: false,
  properties: { format: { type: "string", enum: ["json", "yaml"] } },
} as const;

/** Maximum Idempotency-Key length accepted (issue #72). */
const IDEMPOTENCY_KEY_MAX_LENGTH = 128;

/** Maximum number of in-flight idempotency entries (issue #72). */
const IDEMPOTENCY_MAX_ENTRIES = 1_000;

/**
 * Retention window for idempotency entries: 24 h (issue #72).
 * Entries older than this are pruned lazily on the next lookup.
 */
const IDEMPOTENCY_RETENTION_MS = 86_400_000;

export function buildApp(options: BuildAppOptions): AppInstance {
  const clock = options.clock ?? Date.now;
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: options.config.bodyLimitBytes, ajv: { customOptions: { removeAdditional: false } } });
  app.addContentTypeParser(["application/yaml", "application/x-yaml", "text/yaml"], { parseAs: "string" }, (_request, body, done) => done(null, body));
  // Issue #77: fastify's default text/plain parser would otherwise accept
  // (and then fail validation on) bodies with unsupported content types such
  // as text/plain, masking the real problem behind a 400. Removing it lets
  // every content type we don't explicitly support fall through to fastify's
  // own FST_ERR_CTP_INVALID_MEDIA_TYPE path, which the error handler below
  // maps to a stable 415 UNSUPPORTED_MEDIA_TYPE.
  app.removeContentTypeParser("text/plain");
  const registry = createScenarioRegistry(options.config.scenarioDirectory);
  const persistence = new PersistenceCoordinator(options.config, registry);
  app.addHook("onReady", async () => persistence.initialize());
  app.addHook("onClose", async () => persistence.close());
  const limiter = new FixedWindowRateLimiter(options.config.rateLimitWindowMs);

  // Idempotency store shared across both run-creation endpoints (issue #72).
  // RunService.start returns Promise<RunReport>, so T = RunReport.
  const idempotency = new IdempotencyStore<RunReport>(
    IDEMPOTENCY_MAX_ENTRIES,
    IDEMPOTENCY_RETENTION_MS,
  );

  app.addHook("onRequest", async (request, reply) => {
    const path = request.url.split("?")[0];
    // Issue #85: /health is a cheap liveness probe that must stay reachable
    // even when a client address has exhausted its application quota. Skip
    // rate-limiting for this route entirely; all other routes, including the
    // explicit readiness probe at /ready, continue to be covered.
    if (path === "/health") return;
    const isRunCreation = request.method === "POST" && (path === "/api/v1/runs" || path === "/api/v1/runs/definitions");
    const limit = isRunCreation ? options.config.runRateLimitMax : options.config.rateLimitMax;
    const result = limiter.consume(`${isRunCreation ? "run" : "global"}:${request.ip}`, limit);
    reply.header("x-ratelimit-limit", limit).header("x-ratelimit-remaining", result.remaining);
    if (!result.allowed) { reply.header("retry-after", result.retryAfterSeconds); return reply.code(429).send(apiError("RATE_LIMITED", "Request limit exceeded. Try again later.", request.id)); }
  });
  const ledger = options.ledger ?? new StellarTestnetGateway(options.config.horizonUrl, options.config.friendbotUrl, {
    fundingConcurrency: options.config.maxConcurrentFriendbotRequests,
  });
  const clock = options.clock ?? Date.now;
  const runs = new RunService(persistence.runStore ?? new InMemoryRunStore(options.config.maxStoredRuns, options.config.runRetentionMs, clock), ledger, {
    maxConcurrentRuns: options.config.maxConcurrentRuns, runTimeoutMs: options.config.runTimeoutMs, stepTimeoutMs: options.config.stepTimeoutMs,
  }, clock, options.runLogger ?? app.log);

  app.get("/health", async () => ({ status: "ok", network: "testnet" }));
  if (options.config.metricsEnabled) {
    app.get("/metrics", async (_request, reply) => {
      const metrics = runs.getMetrics();
      const body = [
        "# HELP esure_active_runs Number of currently admitted active runs.",
        "# TYPE esure_active_runs gauge",
        `esure_active_runs ${metrics.activeRuns}`,
        "# HELP esure_terminal_runs_total Completed runs by fixed outcome.",
        "# TYPE esure_terminal_runs_total counter",
        `esure_terminal_runs_total{outcome="passed"} ${metrics.terminalRuns.passed}`,
        `esure_terminal_runs_total{outcome="failed"} ${metrics.terminalRuns.failed}`,
        "# HELP esure_rejected_run_starts_total Rejected starts by fixed reason.",
        "# TYPE esure_rejected_run_starts_total counter",
        `esure_rejected_run_starts_total{reason="capacity"} ${metrics.rejectedStarts.capacity}`,
        `esure_rejected_run_starts_total{reason="draining"} ${metrics.rejectedStarts.draining}`,
        "# HELP esure_run_duration_seconds Duration of terminal runs in seconds.",
        "# TYPE esure_run_duration_seconds summary",
        `esure_run_duration_seconds_sum ${metrics.runDuration.totalMilliseconds / 1_000}`,
        "# HELP esure_run_duration_seconds_count Number of terminal runs included in duration.",
        "# TYPE esure_run_duration_seconds_count counter",
        `esure_run_duration_seconds_count ${metrics.runDuration.count}`,
        "",
      ].join("\n");
      return reply
        .header("Cache-Control", "no-store")
        .type("text/plain; version=0.0.4; charset=utf-8")
        .send(body);
    });
  }
  app.get("/ready", async (_request, reply) => {
    const ready = await persistence.check();
    if (!ready) return reply.code(503).send({ status: "unavailable", network: "testnet", database: "unavailable" });
    return { status: "ready", network: "testnet", database: persistence.state === "disabled" ? "disabled" : "ready" };
  });
  app.get("/openapi.json", async () => openApiDocument());

  // ── Issue #70: canonical schema endpoint / #222: conditional GET ──────────
  app.get("/api/v1/schemas/scenario-v1.json", async (request, reply) => {
    const body = JSON.stringify(scenarioSchemaV1);
    const etag = `"${createHash("sha256").update(body).digest("hex")}"`;
    reply.header("ETag", etag).header("Cache-Control", "no-cache");
    const ifNoneMatchHeader = request.headers["if-none-match"];
    const ifNoneMatch = Array.isArray(ifNoneMatchHeader) ? ifNoneMatchHeader.join(",") : ifNoneMatchHeader;
    if (ifNoneMatch && matchesETag(ifNoneMatch, etag)) return reply.code(304).send();
    return reply.type("application/json").send(body);
  });

  // ── Issue #231: canonical run-report schema endpoint ─────────────────────
  app.get("/api/v1/schemas/run-report-v1.json", async (_request, reply) => {
    return reply.type("application/json").send(runReportSchemaV1);
  });

  // ── Issue #69: conditional GET for scenario catalogue ─────────────────────
  app.get("/api/v1/scenarios", async (request, reply) => {
    const items = persistence.repository ? await persistence.repository.list() : registry.list();
    const etag = catalogueETag(items);
    // Always include explicit revalidation directives so both browsers and
    // reverse proxies know the resource must be revalidated before reuse.
    reply.header("ETag", etag).header("Cache-Control", "no-cache");
    const ifNoneMatch = (request.headers["if-none-match"] as string | undefined)?.trim();
    if (ifNoneMatch && matchesETag(ifNoneMatch, etag)) {
      return reply.code(304).send();
    }
    return { items };
  });

  app.get<{ Params: { scenarioId: string } }>("/api/v1/scenarios/:scenarioId", async (request, reply) => {
    const scenario = persistence.repository ? await persistence.repository.latest(request.params.scenarioId) : registry.find(request.params.scenarioId);
    if (!scenario) return reply.code(404).send(apiError("SCENARIO_NOT_FOUND", "The requested scenario is not available.", request.id));
    const etag = `"${createHash("sha256").update(scenario.contentHash).digest("hex")}"`;
    reply.header("ETag", etag).header("Cache-Control", "no-cache");
    const ifNoneMatchHeader = request.headers["if-none-match"];
    const ifNoneMatch = Array.isArray(ifNoneMatchHeader) ? ifNoneMatchHeader.join(",") : ifNoneMatchHeader;
    if (ifNoneMatch && matchesETag(ifNoneMatch, etag)) return reply.code(304).send();
    return scenario;
  });
  app.get<{ Params: { scenarioId: string }; Querystring: { limit?: string; cursor?: string } }>("/api/v1/scenarios/:scenarioId/versions", { schema: { params: scenarioIdParamsSchema, querystring: historyQuerySchema } }, async (request, reply) => {
    const limit = request.query.limit === undefined ? 20 : parseBoundedInt(request.query.limit, 1, 100);
    if (limit === undefined) return reply.code(400).send(apiError("INVALID_REQUEST", "limit must be an integer between 1 and 100.", request.id));
    let cursor: number | undefined;
    if (request.query.cursor !== undefined) {
      cursor = parseBoundedInt(request.query.cursor, 1, 2_147_483_647);
      if (cursor === undefined) return reply.code(400).send(apiError("INVALID_REQUEST", "cursor must be an integer between 1 and 2147483647.", request.id));
    }
    if (!persistence.repository) return reply.code(503).send(apiError("PERSISTENCE_REQUIRED", "Scenario version history requires published persistence mode.", request.id));
    const history = await persistence.repository.history(request.params.scenarioId, limit, cursor);
    if (!history.items.length && cursor === undefined) return reply.code(404).send(apiError("SCENARIO_NOT_FOUND", "The requested scenario is not available.", request.id));
    return history;
  });
  app.get<{ Params: { scenarioId: string; version: string } }>("/api/v1/scenarios/:scenarioId/versions/:version", { schema: { params: versionParamsSchema } }, async (request, reply) => {
    const version = parseBoundedInt(request.params.version, 1, 2_147_483_647);
    if (version === undefined) return reply.code(400).send(apiError("INVALID_REQUEST", "version must be an integer between 1 and 2147483647.", request.id));
    if (!persistence.repository) return reply.code(503).send(apiError("PERSISTENCE_REQUIRED", "Exact scenario versions require published persistence mode.", request.id));
    const scenario = await persistence.repository.version(request.params.scenarioId, version);
    if (!scenario) return reply.code(404).send(apiError("SCENARIO_VERSION_NOT_FOUND", "The requested scenario version is not available.", request.id));
    return scenario;
  });
  app.get<{ Params: { scenarioId: string; version: string }; Querystring: { format?: "json" | "yaml" } }>("/api/v1/scenarios/:scenarioId/versions/:version/export", { schema: { params: versionParamsSchema, querystring: exportQuerySchema } }, async (request, reply) => {
    const version = parseBoundedInt(request.params.version, 1, 2_147_483_647);
    if (version === undefined) return reply.code(400).send(apiError("INVALID_REQUEST", "version must be an integer between 1 and 2147483647.", request.id));
    if (!persistence.repository) return reply.code(503).send(apiError("PERSISTENCE_REQUIRED", "Scenario export requires published persistence mode.", request.id));
    const format = request.query.format ?? "json";
    const exported = await persistence.repository.export(request.params.scenarioId, version, format);
    if (!exported) return reply.code(404).send(apiError("SCENARIO_VERSION_NOT_FOUND", "The requested scenario version is not available.", request.id));
    return reply.type(format === "json" ? "application/json" : "application/yaml").header("content-disposition", `attachment; filename=${request.params.scenarioId}-v${version}.${format}`).send(exported);
  });
  app.post("/api/v1/scenarios/validate", async (request) => {
    const scenario = submittedScenario(request.body, request.headers["content-type"]);
    return { valid: true, scenarioId: scenario.id, scenarioVersion: scenario.version, schemaVersion: scenario.schemaVersion, contentHash: scenario.contentHash };
  });

  // ── Issue #71: exact version run creation + Issue #72: idempotency ────────
  app.post<{ Body: { scenarioId: string; scenarioVersion?: number; inputs?: Record<string, never> } }>("/api/v1/runs", { schema: { body: runBodySchema } }, async (request, reply) => {
    const { scenarioId, scenarioVersion } = request.body;

    // Resolve the scenario from the active catalogue source (issue #71).
    let scenario: ValidatedScenario | undefined;
    if (persistence.repository) {
      // Published mode: resolve from the persistent catalogue.
      if (scenarioVersion !== undefined) {
        scenario = await persistence.repository.version(scenarioId, scenarioVersion);
        if (!scenario) return reply.code(404).send(apiError("SCENARIO_VERSION_NOT_FOUND", `Scenario ${scenarioId} version ${scenarioVersion} is not available in the published catalogue.`, request.id));
      } else {
        scenario = await persistence.repository.latest(scenarioId);
        if (!scenario) return reply.code(404).send(apiError("SCENARIO_NOT_FOUND", "The requested scenario is not available.", request.id));
      }
    } else {
      // Disabled (bundled) mode: bundled registry holds exactly one version.
      scenario = registry.find(scenarioId);
      if (!scenario) return reply.code(404).send(apiError("SCENARIO_NOT_FOUND", "The requested scenario is not available.", request.id));
      if (scenarioVersion !== undefined && scenario.version !== scenarioVersion) {
        // The bundled definition's version does not match the caller's
        // expectation. Reject explicitly so the caller is not silently
        // executing a different definition than the one they saw.
        return reply.code(409).send(apiError(
          "SCENARIO_VERSION_MISMATCH",
          `Bundled scenario ${scenarioId} is at version ${scenario.version}, not version ${scenarioVersion}. Omit scenarioVersion to always execute the current bundled definition.`,
          request.id,
        ));
      }
    }

    // Idempotency (issue #72).
    const idempotencyKey = extractIdempotencyKey(request.headers["idempotency-key"]);
    if (idempotencyKey) {
      const fingerprint = requestFingerprint({ scenarioId, scenarioVersion });
      const outcome = idempotency.insert(idempotencyKey, fingerprint, () => runs.start(scenario, request.id));
      if (outcome.status === "conflict") {
        return reply.code(409).send(apiError("IDEMPOTENCY_CONFLICT", "The Idempotency-Key was already used with a different request body.", request.id));
      }
      if (outcome.status === "capacity") {
        return reply.code(503).send(apiError("IDEMPOTENCY_CAPACITY", "The idempotency store is at capacity. Retry without an Idempotency-Key or try again later.", request.id));
      }
      // Both "created" and "existing" return the settled result of the original
      // promise, which may be from a concurrent or prior request.
      return reply.code(202).send(await outcome.entry.result);
    }

    return reply.code(202).send(await runs.start(scenario, request.id));
  });

  app.post("/api/v1/runs/definitions", async (request, reply) => {
    const scenario = submittedScenario(request.body, request.headers["content-type"]);

    // Idempotency (issue #72).
    const idempotencyKey = extractIdempotencyKey(request.headers["idempotency-key"]);
    if (idempotencyKey) {
      // The canonical fingerprint covers the entire definition so any field
      // change produces a different fingerprint.
      const fingerprint = requestFingerprint(scenario);
      const outcome = idempotency.insert(idempotencyKey, fingerprint, () => runs.start(scenario, request.id));
      if (outcome.status === "conflict") {
        return reply.code(409).send(apiError("IDEMPOTENCY_CONFLICT", "The Idempotency-Key was already used with a different request body.", request.id));
      }
      if (outcome.status === "capacity") {
        return reply.code(503).send(apiError("IDEMPOTENCY_CAPACITY", "The idempotency store is at capacity. Retry without an Idempotency-Key or try again later.", request.id));
      }
      return reply.code(202).send(await outcome.entry.result);
    }

    return reply.code(202).send(await runs.start(scenario, request.id));
  });

  app.get<{ Params: { runId: string } }>("/api/v1/runs/:runId", { schema: { params: runIdParamsSchema } }, async (request, reply) => {
    const run = await runs.get(request.params.runId);
    if (!run) return reply.code(404).send(apiError("RUN_NOT_FOUND", "The requested run does not exist.", request.id));
    return sendConditionalRunReport(request, reply, withRetentionMetadata(run, options.config.runRetentionMs));
  });
  app.get<{ Params: { runId: string } }>("/api/v1/runs/:runId/report", { schema: { params: runIdParamsSchema } }, async (request, reply) => {
    const run = await runs.get(request.params.runId);
    if (!run) return reply.code(404).send(apiError("RUN_NOT_FOUND", "The requested run does not exist.", request.id));
    if (run.status !== "passed" && run.status !== "failed") return reply.code(409).send(apiError("RUN_NOT_COMPLETE", "The requested run is not complete.", request.id));
    reply.header("content-disposition", `attachment; filename=esure-run-${run.id}.json`);
    return sendConditionalRunReport(request, reply, withRetentionMetadata(run, options.config.runRetentionMs));
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof RunDrainingError) {
      // Issue #223: draining responses signal a permanent (until restart) state;
      // suggest a longer retry window and use a distinct code so clients can
      // differentiate from a temporary capacity limit.
      return reply.code(503).header("retry-after", "60").send({ error: { ...error.report, requestId: request.id, details: [] } });
    }
    if (error instanceof RunCapacityError) {
      // Issue #223: capacity is temporary — the runner may free a slot within
      // seconds. Suggest a short retry window so clients back off predictably.
      return reply.code(503).header("retry-after", "5").send({ error: { ...error.report, requestId: request.id, details: [] } });
    }
    if (error instanceof DatabaseUnavailableError) return reply.code(503).send(apiError("DATABASE_UNAVAILABLE", "The persistent scenario catalogue is temporarily unavailable.", request.id));
    // Issue #81: a persisted scenario row failed its integrity re-check. Respond with a
    // sanitized availability error — never the underlying ScenarioIntegrityError detail.
    if (error instanceof ScenarioIntegrityError) return reply.code(503).send(apiError("CATALOGUE_INTEGRITY_ERROR", "The published scenario catalogue is temporarily unavailable.", request.id));
    if (error instanceof ScenarioValidationError) return reply.code(400).send(apiError("INVALID_SCENARIO", error.message, request.id, error.issues));
    if (isInvalidJsonBodyError(error)) {
      if (isScenarioDefinitionPath(request.url)) {
        return reply.code(400).send(apiError("INVALID_SCENARIO", "Scenario definition is invalid.", request.id, ["definition is not valid JSON"]));
      }
      return reply.code(400).send(apiError("INVALID_REQUEST", "The request body is invalid.", request.id, ["request body is not valid JSON"]));
    }
    if (hasStatus(error, 429)) return reply.code(429).send(apiError("RATE_LIMITED", "Request limit exceeded. Try again later.", request.id));
    if (hasStatus(error, 413)) return reply.code(413).send(apiError("INVALID_REQUEST", "The request body exceeded the allowed size.", request.id));
    if (isUnsupportedMediaTypeError(error)) return reply.code(415).send(apiError("UNSUPPORTED_MEDIA_TYPE", "The request content type is not supported.", request.id));
    if (isValidationError(error)) return reply.code(400).send(apiError("INVALID_REQUEST", "The request did not match the API schema.", request.id));
    request.log.error({ err: error }, "Unhandled request error");
    return reply.code(500).send(apiError("INTERNAL_ERROR", "The request could not be completed.", request.id));
  });
  const instance = app as unknown as AppInstance;
  instance.runs = runs;
  return instance;
}

// ── Issue #69: deterministic ETag for catalogue responses ─────────────────
/**
 * Produce a deterministic ETag for the given catalogue items.
 * The hash covers the sorted canonical JSON of every summary so that any
 * change to a version number or content hash produces a different ETag,
 * regardless of the order in which items are returned from the database.
 */
function catalogueETag(items: { id: string; version: number; contentHash: string }[]): string {
  const sorted = [...items].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const digest = createHash("sha256")
    .update(canonicalJson(sorted.map(({ id, version, contentHash }) => ({ id, version, contentHash }))))
    .digest("hex");
  return `"${digest}"`;
}

/**
 * Returns true when the If-None-Match header value matches the given strong
 * ETag.  Handles:
 *   - wildcard: `*`
 *   - comma-separated lists of quoted tags (RFC 9110 §13.1.2)
 *   - weak tags: W/"..." is treated as equivalent to its strong counterpart
 *     for the purpose of conditional GETs (issue #221).
 * The list is bounded to 32 candidates to prevent linear-scan abuse.
 */
function matchesETag(ifNoneMatch: string, etag: string): boolean {
  if (!ifNoneMatch) return false;
  const candidates = ifNoneMatch.split(",").slice(0, 32);
  return candidates.some((candidate) => {
    const tag = candidate.trim();
    if (tag === "*") return true;
    const normalized = tag.startsWith("W/") ? tag.slice(2) : tag;
    return normalized === etag;
  });
}

function sendConditionalRunReport(
  request: FastifyRequest,
  reply: FastifyReply,
  report: RunReport,
) {
  const body = JSON.stringify(report);
  const etag = `"${createHash("sha256").update(body).digest("hex")}"`;
  reply.header("ETag", etag);
  reply.header("Cache-Control", "no-cache");

  const ifNoneMatchHeader = request.headers["if-none-match"];
  const ifNoneMatch = Array.isArray(ifNoneMatchHeader) ? ifNoneMatchHeader.join(",") : ifNoneMatchHeader;
  if (ifNoneMatch && matchesETag(ifNoneMatch, etag)) {
    return reply.code(304).send();
  }

  return reply.type("application/json").send(body);
}

// ── Issue #72: idempotency helpers ─────────────────────────────────────────
function extractIdempotencyKey(header: unknown): string | undefined {
  if (typeof header !== "string") return undefined;
  const trimmed = header.trim();
  if (!trimmed || trimmed.length > IDEMPOTENCY_KEY_MAX_LENGTH) return undefined;
  return trimmed;
}

/**
 * Canonical JSON fingerprint of the run-creation request body.
 * Used to detect conflicts when the same key is reused with a different body.
 */
function requestFingerprint(body: unknown): string {
  return createHash("sha256").update(canonicalJson(body)).digest("hex");
}

/**
 * Parses a query/path string that has already matched the strict positive-
 * integer text pattern (issue #78) and checks it against numeric bounds that
 * the pattern alone cannot express (e.g. the int32 ceiling). Returns
 * undefined — rather than throwing — so callers can map out-of-range values
 * to the same INVALID_REQUEST envelope used for shape failures.
 */
function parseBoundedInt(value: string, minimum: number, maximum: number): number | undefined {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) return undefined;
  return parsed;
}

// ── Issue #76: run retention metadata ──────────────────────────────────────
/**
 * Adds an `expiresAt` hint to terminal run responses, derived from the
 * configured retention window and the time the run became terminal.
 * Active (non-terminal) runs never get this field — claiming a terminal
 * expiry while a run is still in progress would be misleading.
 *
 * Note (documented limitation, not a bug): the in-memory run store may
 * evict a terminal run earlier than this hint under capacity pressure, and
 * no run state survives a process restart. `expiresAt` is a best-effort
 * upper bound, not a guarantee.
 */
function withRetentionMetadata<T extends RunReport>(run: T, retentionMs: number): T & { expiresAt?: string } {
  if ((run.status !== "passed" && run.status !== "failed") || !run.completedAt) return run;
  const expiresAt = new Date(Date.parse(run.completedAt) + retentionMs).toISOString();
  return { ...run, expiresAt };
}

// ── Issue #77: unsupported content type ────────────────────────────────────
function isUnsupportedMediaTypeError(error: unknown): boolean {
  return typeof error === "object" && error !== null &&
    "code" in error && error.code === "FST_ERR_CTP_INVALID_MEDIA_TYPE" &&
    "statusCode" in error && error.statusCode === 415;
}

function submittedScenario(body: unknown, contentType: string | undefined): ValidatedScenario {
  const mediaType = contentType?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType === "application/yaml" || mediaType === "application/x-yaml" || mediaType === "text/yaml") {
    if (typeof body !== "string") throw new ScenarioValidationError(["YAML request body must be text"]);
    return parseScenario(body, "yaml");
  }
  return prepareScenario(body);
}
function apiError(code: string, message: string, requestId: string, details: string[] = []) { return { error: { code, message, requestId, details: details.slice(0, 50) } }; }
function isValidationError(error: unknown): error is { validation: unknown } { return typeof error === "object" && error !== null && "validation" in error; }
function hasStatus(error: unknown, status: number): boolean { return typeof error === "object" && error !== null && "statusCode" in error && error.statusCode === status; }
function isInvalidJsonBodyError(error: unknown): boolean {
  return typeof error === "object" && error !== null &&
    "name" in error && error.name === "FastifyError" &&
    "code" in error && error.code === "FST_ERR_CTP_INVALID_JSON_BODY" &&
    "statusCode" in error && error.statusCode === 400;
}
function isScenarioDefinitionPath(url: string): boolean {
  const path = url.split("?", 1)[0];
  return path === "/api/v1/scenarios/validate" || path === "/api/v1/runs/definitions";
}
