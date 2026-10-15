# P2 Persistence Contract

P2 adds an optional PostgreSQL-backed published-scenario catalogue and,
separately, opt-in run-report persistence. `PERSISTENCE_MODE=disabled` is the
default. `published` mode never falls back to memory: the process verifies every
migration filename and SHA-256 checksum at startup and fails readiness/startup
if the database is missing or stale. Run reports remain in memory unless
`RUN_PERSISTENCE_ENABLED=true` is also set; enabling it requires
`PERSISTENCE_MODE=published` and `DATABASE_URL`.

Migration 003 extends the existing `runs` table with report fields and a stable
`run_id`. Existing normalized worker-run columns and child tables remain
available. PostgreSQL run reports keep the existing API shape, redact Stellar
secret seeds and account keys before writing JSON, and expire from reads using
`RUN_RETENTION_MS`. The supplied
`migrations/003_persistent_run_history.down.sql` reverses the additive change
and deletes report-only rows; use it only when intentionally discarding that
history.

## Identity and immutability

`scenarios.id` is a server UUID. Bundled/operator scenarios alone have a unique
stable `public_slug`; anonymous inline scenarios must have `public_slug = NULL`,
are unlisted, and retain the submitted scenario ID only as metadata. An inline
definition therefore cannot claim or modify a published slug.

`scenario_versions` is append-only. `(scenario_id, version_number)` and
`(scenario_id, content_hash)` are unique. A trigger rejects every update and
delete. A future cleanup deletion is allowed only when the session is operating
as the maintenance role, explicitly sets the transaction-local
`esure.cleanup_mode=on`, and no run references the version. The foreign key from
`runs` is `RESTRICT`; run children use `CASCADE`, enforcing the approved cleanup
order: terminal run, unreferenced inline version, empty inline scenario.

Fixture reconciliation locks the scenario row, compares canonical definitions
without the server-managed version number, and either does nothing or assigns
`max(version_number)+1` inside the same transaction. It rewrites the definition's
version and calculates the canonical SHA-256 hash before insertion. Constraints
provide the final concurrency guard.

## Database roles

- `esure_application`: read published scenarios/versions and create/update run
  reports. It cannot mutate versions or access cleanup audit records.
- `esure_worker`: later claims and progressively updates runs and evidence. It
  cannot mutate scenario versions or access cleanup audit records.
- `esure_maintenance`: future bounded cleanup only. Version deletion additionally
  requires the trigger conditions above and must create an audit entry.
- `esure_migrations`: owns schema changes and fixture reconciliation. Its URL is
  used only by explicit one-shot commands, never by the web process.

`database/bootstrap-roles.sql` creates NOLOGIN group roles. Each environment uses
separate provider-managed LOGIN credentials granted exactly one group role. Run
`npm run db:migrate` and `npm run db:reconcile` with
`DATABASE_MIGRATION_URL`; the backend receives only the application URL.

Render supports multiple managed PostgreSQL credentials and also permits users
created with SQL, although SQL-created users are not managed in its dashboard.
The secure deployment equivalent is separate Render-managed login credentials,
membership in the NOLOGIN group roles above, and direct port 5432 for migrations.
Transaction-mode PgBouncer is compatible with the transaction-scoped advisory
migration lock; direct connections remain preferable for migrations. The Node
pool defaults to five connections with 5-second connection/query timeouts and a
10-second idle timeout.

Migrations are numbered, applied in one transaction under a transaction-scoped
advisory lock, and recorded with filename plus SHA-256 checksum. A changed
historical migration or missing migration fails startup verification. A failed
migration rolls back completely. Production rollback uses a pre-migration
backup/point-in-time restore for destructive incompatibility and a new forward
repair migration for ordinary defects; applied migration files are never edited
and automatic destructive down-migrations are not used.

References: [Render database credentials](https://render.com/docs/postgresql-credentials)
and [Render connection pooling](https://render.com/docs/postgresql-connection-pooling).

## Later-phase contracts (not active in P2.0-P2.2)

Every worker mutation will be fenced by `lease_owner`, a monotonically increasing
`lease_epoch`, an unexpired lease, and the expected run status. Heartbeats,
progress writes, and finalization use compare-and-set predicates. A stale worker
must stop after any zero-row mutation.

Idempotency records store `hmac-sha256(key)` rather than the supplied key and bind
it to an endpoint plus canonical `sha256` request fingerprint. Same key/request
returns the original run; a mismatch returns a generic 409 without revealing an
inline definition.

Before any Stellar submission, the exact signed transaction is built in memory,
its deterministic transaction hash is persisted with prepared step evidence,
and that transaction commits under the active lease. Seeds and signed/raw XDR are
never persisted. If persistence fails before that commit, no submission occurs.
If persistence fails after submission, the transaction is never automatically
resubmitted; recovery later queries Testnet Horizon by the stored hash.
