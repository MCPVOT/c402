# c402 Protocol

**The Colombian HTTP 402 fiat payment standard for AI agents and pay-per-call APIs.**

[![CI](https://github.com/MCPVOT/c402/actions/workflows/ci.yml/badge.svg)](https://github.com/MCPVOT/c402/actions/workflows/ci.yml)
[![Status](https://img.shields.io/badge/status-draft_standard-00e5ff?style=flat-square&labelColor=0d1117)](./SPEC.md)
[![License: MIT](https://img.shields.io/badge/license-MIT-00ff88?style=flat-square&labelColor=0d1117)](./LICENSE)
[![Production](https://img.shields.io/badge/production--proven-xpequi.xyz-00ff88?style=flat-square&labelColor=0d1117)](https://xpequi.xyz)
[![Companion](https://img.shields.io/badge/companion-x402_(Base_USDC)-8b5cf6?style=flat-square&labelColor=0d1117)](https://www.coinbase.com/developer-platform/discover/launches/x402)

> HTTP 402 sat unused for 30 years. [x402](https://x402.org) gave it stablecoins.
> **c402 gives it Colombia**: Wompi, PSE, Nequi, Daviplata, Bancolombia.
>
> No wallet. No crypto. No card. The rails 50 million Colombians already use.

---

## The flow

```
Client                          Server (API)                    Wompi
  |  GET /v1/resource            |                              |
  | ---------------------------> |                              |
  |  402 + X-402-Challenge       |                              |
  | <--------------------------  |  challenge: nonce, COP, TTL  |
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

## Quick start

```bash
npm install
npm test        # 93 conformance tests
npm run build
cd rust/c402-verify && cargo test   # 12 receipt-vector tests
```

Then wire it up:

1. Read the [normative specification](./SPEC.md): message formats, money units, security model.
2. Pick a store: `UpstashRestStore` for production, `MemoryStore` for tests and single-instance deployments.
3. Copy the wiring from [`adapters/next/`](./adapters/next) (gateway and Wompi webhook) or call the core directly.

```ts
import { UpstashRestStore } from 'c402-protocol/stores/upstash-rest'
import { settleAndGrant, StoreCreditLedger, signReceipt } from 'c402-protocol'

const store = new UpstashRestStore({ url: env.UPSTASH_URL, token: env.UPSTASH_TOKEN })
const result = await settleAndGrant({ store, ledger: new StoreCreditLedger(store), event })
if (result.ok) {
  const receipt = signReceipt(result.challenge, event, env.C402_RECEIPT_SECRET)
  // hand the receipt to the client; anyone with the secret can verify it offline
}
```

## Non-negotiables (from the spec)

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

## Agent-friendly surface (2.2)

An unattended client needs more than a 402 body. c402 2.2 answers:

| Question | Where |
|---|---|
| What unit is the price in? | `amountCents`, integer centavos (SPEC 2) |
| What can I pay with? | `rails` in `/.well-known/c402.json` |
| How do I know a payment landed? | `GET /c402/status/<nonce>` -> `pending / paid / expired / unknown` |
| Can I prove the grant elsewhere? | signed receipt, verified offline by `c402-protocol/receipt` or the Rust crate |
| Which protocol version is this? | `version` in the payload and `X-402-Version` header |
| How long can I still redeem after expiry? | `redemptionGraceSeconds` (default 24 h) |

## What is in this repository

| Path | Contents |
|---|---|
| `src/` | Framework-agnostic core: challenge lifecycle, settlement verification, ledger, pricing, headers, discovery, receipts, Wompi provider, stores |
| `tests/` | Conformance suite, including a non-atomic store the suite is required to reject |
| `rust/c402-verify/` | Offline receipt verifier in Rust; shares a byte-identical test vector with TypeScript |
| `adapters/next/` | Copy-paste wiring for Next.js App Router (not part of the published package) |
| `SPEC.md` | Normative protocol specification, v2.2 |
| `CONFORMANCE.md` | Implementer checklist for certifying your own stack |
| `docs/AUDIT-2.2.md` | The audit that produced 2.2: findings, proof, severity |
| `CHANGELOG.md` | Protocol and implementation history |

## Why c402 exists

Colombia has world-class instant payment rails and no agent-native monetization layer. x402 gave stablecoin APIs autonomous payments; c402 brings the same capability to every Colombian API, using the money and rails people already use every day.

**Live deployment:** [Pequi API](https://xpequi.xyz) - Colombia's first public real-estate data API (31 endpoints, 276 barrios), monetized end to end with c402.

## Version 2.2: four more defects fixed

Version 2.1 fixed three defects and declared the implementation audited. Re-auditing it found four more, three of which lose money:

1. **A store outage looked like an unknown challenge**, so a valid payment was acknowledged and dropped instead of retried.
2. **A failed credit grant burned the settlement claim**, so the buyer paid and no retry could ever grant.
3. **The retry window was shorter than the settlement grace**, so late but valid payments granted credits the client could not spend.
4. **Expired challenges never stopped counting**, so twenty abandoned challenges locked a paying caller out.

Plus: malformed timestamps failed open, nonce parsing accepted path-like values, the price ladder's `minCalls` was decorative, and the adapters could not be copied out of the repo. Each fix carries a regression test, and [docs/AUDIT-2.2.md](./docs/AUDIT-2.2.md) records the probe output that proved it.

Version 2.1 fixed: the non-atomic claim (double grant), the amount/unit contradiction (100x), and the gateway that failed open. Full detail in [CHANGELOG.md](./CHANGELOG.md).

## Roadmap

- ~~**P5** - signed payment receipts (HMAC) for offline grant verification~~ (shipped 2.2)
- **P6** - multi-provider abstraction (Nequi direct, Bancolombia Transfer)
- **P7** - x402 interop bridge: one challenge, payable in COP *or* USDC

---

*Authored by [AI Architek](https://mcpvot.github.io) - MIT License*
