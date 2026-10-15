# Esure Scenario Schema v1

Scenario Schema v1 is a bounded, declarative JSON/YAML format for classic
Stellar payment tests. Document order is execution order. Definitions contain
no executable code or credentials and are validated before Testnet access.

## Bundled Scenarios

ESURE includes 10 MVP scenarios for Testnet integration testing:

| Scenario ID | Purpose | Expected Result |
| --- | --- | --- |
| `xlm-payment` | Fund two accounts, transfer 5 XLM, verify balance change | Pass |
| `issued-asset-payment` | Create TESTUSD trustline, issue 100 TESTUSD, verify balance | Pass |
| `missing-trustline` | Attempt issued-asset payment without recipient trustline | Controlled `op_no_trust` failure |
| `insufficient-xlm-balance` | Attempt to send more XLM than available in account | Controlled `op_underfunded` failure |
| `payment-with-memo` | Send XLM with memo for transaction tracking | Pass |
| `multi-operation-transaction` | Execute trustline + payment atomically in single tx | Pass |
| `trustline-limit-exceeded` | Attempt payment exceeding trustline limit | Controlled `op_line_full` failure |
| `trustline-already-exists` | Multiple payments using existing trustline | Pass |
| `basic-payment-with-checks` | Send XLM and verify both accounts exist | Pass |
| `minimum-xlm-payment` | Send minimum viable XLM (1 stroop) | Pass |
| `path-payment` | Create EUR/XLM and USDC/EUR offers and send XLM through EUR to deliver USDC | Pass on Testnet |

These scenarios demonstrate XLM transfers, issued assets, trustline management,
expected failure handling, and multi-step transaction flows that Stellar developers
commonly need to test.

`path-payment` provisions its own Testnet liquidity. It creates generated sender,
market-maker, recipient, and issuer accounts, then submits trustlines, issues
test-issued EUR/USDC assets to the market maker, and places EUR/XLM and USDC/EUR
sell offers. The USDC in this isolated scenario is not Circle-issued USDC. A
strict-receive path payment converts sender XLM through EUR to deliver exactly
5 USDC to the recipient (with a 10 XLM maximum). It does not depend on
pre-existing public order-book liquidity.

```yaml
schemaVersion: 1
id: coffee-token-payment
version: 1
name: Coffee token payment
description: Issue COFFEE and transfer it through a trustline.
network: testnet
accounts:
  - { id: issuer, generate: true, fund: true }
  - { id: customer, generate: true, fund: true }
assets:
  - { id: xlm, type: native }
  - { id: coffee, type: issued, code: COFFEE, issuer: issuer }
steps:
  - id: customer-trusts-coffee
    type: changeTrust
    account: customer
    asset: coffee
  - id: issuer-pays-customer
    type: payment
    from: issuer
    to: customer
    asset: coffee
    amount: "25"
assertions:
  - { type: balanceEquals, account: customer, asset: coffee, amount: "25" }
  - { type: trustlineExists, account: customer, asset: coffee }
  - { type: stepSucceeded, step: issuer-pays-customer }
  - { type: transactionConfirmed, step: issuer-pays-customer }
  - { type: accountExists, account: customer }
```

## Accounts and assets

- Accounts must use `{ generate: true }`; secret seeds and imported accounts are
  not accepted. `fund: true` funds the generated account through official
  Testnet Friendbot.
- Every scenario declares exactly one native asset.
- Issued assets reference an account in the same definition as issuer and use a
  1–12 character uppercase alphanumeric classic asset code.

## Operations

- `changeTrust`: `id`, `account`, `asset`, and optional positive `limit`.
- `payment`: `id`, `from`, `to`, `asset`, and positive decimal `amount`.
- `manageSellOffer`: `id`, `account`, `sellingAsset`, `buyingAsset`, positive
  `amount`, and positive `price`.
- `pathPaymentStrictReceive`: `id`, `from`, `to`, `sendAsset`, `sendMax`,
  `destAsset`, `destAmount`, and up to five intermediate `path` asset IDs.
- `pathPaymentStrictSend`: `id`, `from`, `to`, `sendAsset`, `sendAmount`,
  `destAsset`, `destMin`, and up to five intermediate `path` asset IDs.

Amounts are strings with at most seven fractional digits and must fit Stellar's
signed 64-bit stroop range.

## Assertions

- `balanceEquals(account, asset, amount)`
- `balanceChangedBy(account, asset, amount)`; signed deltas are supported
- `stepSucceeded(step)`
- `stepFailedWith(step, transactionCode, operationCodes)`; the complete
  normalized transaction and operation-code sequence must match exactly
- `trustlineExists(account, asset)`
- `trustlineMissing(account, asset)`
- `transactionConfirmed(step)`
- `accountExists(account)`

Reports include explicit `expected` and `actual` values for every assertion,
plus `scenarioVersion`, `scenarioSchemaVersion`, and a canonical SHA-256
`scenarioContentHash`.

## Validation and limits

- Only `network: testnet` and `schemaVersion: 1` are accepted.
- Unknown properties, duplicate IDs, unresolved references, native trustlines,
  invalid amounts/limits, malformed asset codes, and unsupported operations or
  assertions are rejected before execution.
- Maximums: 10 accounts, 10 assets, 20 steps, 20 assertions, 16 KiB per
  submitted/file definition, and 100 files per configured directory.
- YAML duplicate keys and aliases are rejected.
- Stellar secret seeds, URLs, script fields, transaction envelopes, and raw XDR
  are rejected. Generated secret keys exist only in runner memory during a run.

## Loading and running

- Bundled definitions live in the backend `scenarios/` directory.
- A server operator can set `SCENARIO_DIRECTORY` to load additional JSON/YAML
  files without editing application source.
- `POST /api/v1/scenarios/validate` validates raw JSON or YAML without execution.
- `POST /api/v1/runs/definitions` validates and executes raw JSON or YAML.
- `POST /api/v1/runs` continues to execute a catalogued definition by ID.

The OpenAPI 3.1 contract and embedded Scenario v1 JSON Schema are available at
`GET /openapi.json`.
