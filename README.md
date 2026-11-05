# c402

**HTTP 402 for Colombian fiat. Agents and apps pay per call in COP over the rails people already use — no wallet, no crypto, no card.**

[![CI](https://github.com/MCPVOT/c402/actions/workflows/ci.yml/badge.svg)](https://github.com/MCPVOT/c402/actions/workflows/ci.yml)
[![Status](https://img.shields.io/badge/status-draft_standard-00e5ff?style=flat-square&labelColor=0d1117)](./SPEC.md)
[![Version](https://img.shields.io/badge/protocol-2.2-00ff88?style=flat-square&labelColor=0d1117)](./CHANGELOG.md)
[![Platforms](https://img.shields.io/badge/CI-linux%20%7C%20macOS%20%7C%20windows-8b5cf6?style=flat-square&labelColor=0d1117)](#platforms)
[![License: MIT](https://img.shields.io/badge/license-MIT-00ff88?style=flat-square&labelColor=0d1117)](./LICENSE)
[![Production](https://img.shields.io/badge/production--proven-xpequi.xyz-00ff88?style=flat-square&labelColor=0d1117)](https://xpequi.xyz)

**Read next:** [Specification](./SPEC.md) (normative) · [Conformance](./CONFORMANCE.md) (certify your own stack) · [Audit](./docs/AUDIT-2.2.md) (what was broken, with proof) · [Security](./SECURITY.md) (reporting, scope) · [Changelog](./CHANGELOG.md)

---

HTTP 402 sat unused for thirty years. [x402](https://x402.org) gave it stablecoins. **c402 gives it Colombia**: Wompi, PSE, Nequi, Daviplata and Bancolombia transfer, in COP, on the rails 50 million Colombians already use.

An agent that hits a paid endpoint gets a machine-readable challenge: how much, in what unit, for how many calls, until when, and where to pay. It pays in a browser or an app, the provider webhooks the server, and the retry carries a payment id instead of a card.

```
Client                          Server (API)                    Wompi
  |  GET /v1/resource            |                              |
  | ---------------------------> |                              |
  |  402 + X-402-Challenge       |                              |
  | <--------------------------  |  nonce, amountCents, TTL     |
  |                              |                              |
  |  open paymentUrl (PSE / Nequi / card / Bancolombia) ------> |
  |                              |  webhook: transaction.updated|
  |                              | <----------------------------|
  |                              |  verify amount + currency    |
  |                              |  atomic claim (SET NX)       |
  |  retry + X-402-Payment-Id    |  grant credits               |
  | ---------------------------> |                              |
  |  200 + data (+ receipt)      |                              |
  | <--------------------------  |                              |
```

## Status

**Draft standard, running in production** at [Pequi API](https://xpequi.xyz) — 31 endpoints, 276 barrios, monetized end to end with c402.

| | |
|---|---|
| Works today | challenge lifecycle, settlement with atomic claim, prepaid ledger, fail-closed gateway, Wompi provider, discovery, status, signed receipts |
| Reference implementation | TypeScript core (`src/`), Next.js adapters, Rust receipt verifier |
| Tested | 101 TypeScript tests, 17 Rust tests, CI on Linux / macOS / Windows (counts from the merge commit; CI runs the same commands) |
| Not yet | Nequi-direct and Bancolombia-transfer providers (P6), x402 interop (P7), a hosted status service |

The 2.2 release fixed four defects that lost money or locked users out. They are documented with the probe output that proved them, not as a claim that everything is fine: [docs/AUDIT-2.2.md](./docs/AUDIT-2.2.md).

## 60-second demo

No network, no provider account, no API key:

```bash
npm install
npm run demo
```

```
challenge      b0c64c9e-7d02-4312-b1fd-0771e26f6902
price          250000 centavos = COP 2500
calls          50
expires        2026-11-05T16:13:55.594Z
status now     pending
settle         ok, granted 50 calls
balance        50
replay         refused: already_settled
second tx      refused: already_settled
underpay       refused: amount_mismatch
paid exact     ok, granted 100 calls
new balance    100
receipt sig    889c123a8daf33b3…
verify         {"ok":true}
tampered       {"ok":false,"reason":"bad_signature"}
discovery      c402 2.2, rails: wompi, pse, nequi, daviplata, bancolombia_transfer
final status   paid
```

Every line above is printed by `examples/demo.mjs` against the built package: the happy path, a duplicate webhook, a reused reference, an underpayment, and a receipt that verifies — then fails once a single digit changes.

## Install and run the suite

```bash
npm install
npm run typecheck   # source + tests
npm test            # 101 conformance tests
npm run build
cd rust/c402-verify && cargo test   # 17 tests, cross-language vector
```

## Wire it up

```ts
import { UpstashRestStore, settleAndGrant, StoreCreditLedger, signReceipt } from 'c402-protocol'

const store = new UpstashRestStore({ url: env.UPSTASH_URL, token: env.UPSTASH_TOKEN })
const ledger = new StoreCreditLedger(store)

// In the webhook route, after verifying the provider checksum over the raw body:
const result = await settleAndGrant({ store, ledger, event })
if (result.ok) {
  const receipt = signReceipt(result.challenge, event, env.C402_RECEIPT_SECRET)
  return Response.json({ received: true, creditsAdded: result.granted, receipt })
}
```

Copy the full wiring from [`adapters/next/`](./adapters/next) — a gateway that mints challenges and a Wompi webhook that settles them. Both import `c402-protocol`, so they work once copied into your app.

## Non-negotiables (enforced by the suite)

| Rule |
|---|
| **Amounts are integer minor units (centavos), never peso values.** |
| Verify settled **amount and currency** server-side before granting anything |
| **Atomically claim the nonce with `SET ... NX`**: concurrent webhooks must never double-grant |
| Verify the webhook signature with timing-safe comparison over the **raw body** |
| Idempotency keyed on `transaction.id`, never `event.id` |
| Challenges are bound to an API key, UUID v4 nonce, TTL of 30 minutes or less |
| **Fail closed** (503 + Retry-After) when the challenge store is unreachable |
| A store outage is **not** an unknown challenge; a failed grant **releases** the claim |
| The retry window is **at least** as long as the settlement grace |

## The agent surface

An unattended client cannot read a marketing page. c402 2.2 answers the questions an agent actually has:

| Question | Answer |
|---|---|
| What unit is the price in? | `amountCents`, integer centavos ([SPEC §2](./SPEC.md)) |
| What can I pay with? | `rails` in `GET /.well-known/c402.json` |
| Did my payment land? | `GET /c402/status/<nonce>` -> `pending` / `paid` / `expired` / `unknown` |
| Can I prove the grant elsewhere? | `c402-receipt-v1` HMAC receipt, verified offline by TS or Rust |
| Which version is this? | `version` in the payload, `X-402-Version` header |
| How long can I redeem after expiry? | `redemptionGraceSeconds` (default 24 h) |
| What if the store is down? | `503` + `Retry-After`, never free traffic and never a dropped payment |

## Reason codes

Settlement returns a stable machine-readable reason. Adapters map them to HTTP; a harness should branch on the reason, not on prose.

| `SettleReason` | HTTP | Retry? | Meaning |
|---|---|---|---|
| `ok` | 200 | — | credits granted exactly once |
| `already_settled` | 200 | no | duplicate delivery, already granted |
| `claim_lost` | 200 | no | another concurrent delivery won the claim |
| `unknown_challenge` | 200 | no | reference is not a c402 challenge on this server |
| `invalid_status` | 200 | no | provider says the money did not move |
| `invalid_challenge` | 200 | no | stored record is corrupt; retrying cannot repair it |
| `amount_mismatch` | 409 | no | under/overpayment, terminal |
| `currency_mismatch` | 409 | no | wrong currency, terminal |
| `expired_beyond_grace` | 410 | no | settlement arrived after the grace window |
| `store_unavailable` | 503 | **yes** | store unreachable; the payment may be real |
| `grant_failed` | 503 | **yes** | claim released; a retry can still grant |

## Why not just x402, or Stripe?

| | x402 | Stripe | c402 |
|---|---|---|---|
| Buyer needs | a crypto wallet + USDC | a card | a Nequi/PSE/Bancolombia account |
| Settlement | on-chain | T+2 card rails | instant COP transfer |
| Agent-autonomous | yes | no (human checkout) | yes (payment URL is the only human step) |
| Protocol surface | 402 | proprietary API | 402 + discovery + status + receipt |
| Verifiable offline | on-chain proof | no | HMAC receipt |

c402 is not a wallet and not a PSP. It is the **negotiation layer** between an API that wants to charge and a caller that can pay over rails it already has.

## Security model: what you must run, what anyone can check

| Boundary | Who must get it right |
|---|---|
| Webhook authenticity | **You**: checksum over the raw body, constant time |
| Amount and currency | **You**: exact integer comparison, before the claim |
| Single grant | **You**: `SET ... NX` on a real store |
| Retry authorisation | **You**: ownership, paid flag, redemption window |
| Receipt authenticity | **Anyone** with the receipt secret: HMAC-SHA256, offline |
| Receipt forgery | Not possible without the secret; tampering fails closed |

A receipt proves a grant happened. It does **not** prove credits remain unspent — that needs the issuer's ledger. Do not overclaim it.

## Cross-verification (two implementations, one vector)

The TypeScript issuer and the Rust verifier build the same canonical bytes and assert the same signature hex:

```
c402-receipt-v1
nonce=…
keyHash=<sha256(apiKeyId) hex>
amountCents=250000
currency=COP
calls=50
transactionId=tx-001
paidAt=2026-08-24T21:00:00.000Z
expiresAt=2026-08-24T21:30:00.000Z
```

Signature `35c7221a…e44d14` is asserted in [`tests/receipt.test.ts`](./tests/receipt.test.ts) and [`rust/c402-verify/tests/vector.rs`](./rust/c402-verify/tests/vector.rs). Change the canonical form on one side and both suites fail.

```bash
cd rust/c402-verify
cargo run --example verify_file -- receipt.txt "$C402_RECEIPT_SECRET"
# VALID
```

## Version identity

Three things carry a version, and mixing them up turns a format mismatch into a mystery:

| Field | Answers |
|---|---|
| `package.json` version (`2.2.0`) | which code you are running |
| protocol `version` (`2.2`) | which wire format the challenge uses; a different major is refused |
| `c402-receipt-v1` | which receipt format; an unknown tag is refused, never guessed |

## Platforms

| | Linux | macOS | Windows |
|---|---|---|---|
| TypeScript core + tests | ✅ | ✅ | ✅ |
| Rust verifier + tests | ✅ | ✅ | ✅ |
| Receipt text form | LF | LF | **CRLF and UTF-8 BOM accepted** |

The canonical receipt form is LF-only, so readers normalise CRLF and a BOM before verifying. `.gitattributes` pins the repo to LF, and CI runs every suite on the three platforms above.

## Repository layout

| Path | What it is |
|---|---|
| `src/challenge.ts` | challenge lifecycle, settlement orchestration, retry authorisation |
| `src/settlement.ts` | amount, currency, status and grace verification |
| `src/ledger.ts` | prepaid credits, atomic deduct with rollback |
| `src/gateway-decision.ts` | pure allow / 402 / 503 decision, fail-closed |
| `src/http.ts` | `X-402-*` headers, payload encode/parse, version negotiation |
| `src/discovery.ts` | `/.well-known/c402.json` and payment-status projection |
| `src/receipt.ts` | HMAC receipts: sign, verify, text form (CRLF/BOM safe) |
| `src/providers/wompi.ts` | checksum verification, event normalisation, checkout URL |
| `src/stores/upstash-rest.ts` | production store: real `SET ... NX`, `releaseClaim` |
| `src/stores/memory.ts` | in-process store for tests and single-instance deployments |
| `examples/demo.mjs` | the runnable demo quoted above |
| `rust/c402-verify/` | offline receipt verifier, same vector as TypeScript |
| `adapters/next/` | copy-paste App Router wiring |
| `tests/defects.test.ts` | the six regressions that make 2.2 meaningful |
| `docs/AUDIT-2.2.md` | findings, probe output, severity, clean results |
| `SPEC.md` · `CONFORMANCE.md` · `CHANGELOG.md` | normative spec, checklist, history |
| `SECURITY.md` · `CONTRIBUTING.md` | private disclosure and scope; the contribution loop |

## Version 2.2: what was broken

2.1 fixed three defects and declared the implementation audited. Re-auditing it found four more, three of which lose money:

1. A **store outage looked like an unknown challenge**, so a valid payment was acknowledged and dropped instead of retried.
2. A **failed credit grant burned the settlement claim**: the buyer paid and no retry could ever grant.
3. The **retry window was shorter than the settlement grace**: late but valid payments granted credits the client could not spend.
4. **Expired challenges never stopped counting**, so twenty abandoned challenges locked a paying caller out.

Plus: malformed timestamps failed open, nonce parsing accepted path-like values, the price ladder's `minCalls` was decorative, and the adapters could not be copied out of the repo.

Every fix has a regression test, and [docs/AUDIT-2.2.md](./docs/AUDIT-2.2.md) records the probe output that proved it.

## Roadmap

- ~~**P5** — signed payment receipts (HMAC) for offline grant verification~~ (shipped 2.2)
- **P6** — multi-provider abstraction: Nequi direct, Bancolombia transfer
- **P7** — x402 interop bridge: one challenge, payable in COP *or* USDC
- **P8** — transparency log for issued receipts, so a grant can be checked without the issuer

## Contributing

Read [CONFORMANCE.md](./CONFORMANCE.md) first: it is the checklist every change is judged against. The full loop is in [CONTRIBUTING.md](./CONTRIBUTING.md); security reports go through [SECURITY.md](./SECURITY.md), never a public issue. Then:

```bash
npm install
npm run typecheck && npm test && npm run build
cd rust/c402-verify && cargo test
```

A change to the settlement order, the money unit, the claim primitive or the receipt canonical form needs a test that fails without it. `tests/defects.test.ts` is the model: reproduce the defect as an assertion, then fix it.

---

*Authored by [AI Architek](https://mcpvot.github.io) · MIT License · protocol 2.2, November 2026*
