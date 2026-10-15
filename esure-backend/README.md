# Esure Backend

The API and scenario runner for Esure, an open-source testing toolkit for
Stellar payments.

## Requirements

- Node.js 20 or newer
- Network access to Stellar Testnet for live runs
- PostgreSQL 13+ only when the optional published persistence mode is enabled

## Setup

```bash
npm install
copy .env.example .env
npm run dev
```

The API listens on `http://localhost:3001` by default.

## Commands

```bash
npm run dev        # start with file watching
npm run build      # compile TypeScript
npm test           # run unit/API tests
npm run typecheck  # check types without emitting files
npm run check      # typecheck and test
```

The default runner limits each step to 30 seconds, each run to 120 seconds,
and concurrent execution to two runs. Request rates, in-memory retention, body
size, and concurrency are configurable through the bounded values documented in
`.env.example`.

## Initial endpoints

- `GET /health`
- `GET /ready`
- `GET /api/v1/scenarios`
- `GET /api/v1/scenarios/:scenarioId`
- `GET /api/v1/scenarios/:scenarioId/versions`
- `GET /api/v1/scenarios/:scenarioId/versions/:version`
- `GET /api/v1/scenarios/:scenarioId/versions/:version/export?format=json|yaml`
- `POST /api/v1/scenarios/validate`
- `POST /api/v1/runs`
- `POST /api/v1/runs/definitions`
- `GET /api/v1/runs/:runId`
- `GET /api/v1/runs/:runId/report`
- `GET /openapi.json`

Start a live Testnet run:

```bash
curl -X POST http://localhost:3001/api/v1/runs \
  -H "content-type: application/json" \
  -d '{"scenarioId":"issued-asset-payment","inputs":{}}'
```

Run state is stored in memory by default and is lost when the process restarts.
To persist sanitized run reports in PostgreSQL, set
`PERSISTENCE_MODE=published`, configure `DATABASE_URL`, run the migrations, and
set `RUN_PERSISTENCE_ENABLED=true`. Run persistence defaults to disabled, and
the API report format remains unchanged. Generated Testnet secret keys and
account keys are never included in persisted reports.

P2.0-P2.2 optionally persist only the published scenario catalogue. The default
`PERSISTENCE_MODE=disabled` preserves the P1 path. Published mode is fail-closed
and requires separately applied checksummed migrations and reconciled fixtures;
see `../esure-docs/PERSISTENCE.md`.

Bundled scenarios are declarative files in `scenarios/`. Set
`SCENARIO_DIRECTORY` to load additional bounded JSON/YAML definitions at startup,
or submit a definition directly to `/api/v1/runs/definitions`. Definitions are
validated before account generation or network access. See
`../esure-docs/SCENARIOS.md` and `/openapi.json` for Schema v1 and API details.

Run the opt-in live smoke test only when real Testnet access is intended:

macOS / Linux:

```bash
RUN_STELLAR_SMOKE=1 npm test -- test/testnet-smoke.test.ts
```

Windows PowerShell:

```powershell
$env:RUN_STELLAR_SMOKE="1"
npm test -- test/testnet-smoke.test.ts
Remove-Item Env:RUN_STELLAR_SMOKE
```

The same smoke test runs on a daily GitHub Actions schedule. Normal pull-request
tests remain deterministic and make no external network calls.

## Safety

The runner is locked to Stellar Testnet. Scenario Schema v1 accepts only
generated accounts, native/issued assets, `changeTrust`, and `payment`. It
rejects secret seeds, arbitrary transaction envelopes, URLs, scripts, raw XDR,
unknown properties, unresolved references, and definitions above its resource
budgets.
