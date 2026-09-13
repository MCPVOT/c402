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
  |  200 + data                  |                              |
  | <--------------------------  |                              |
```

## Quick start

```bash
npm install
npm test        # 54 conformance tests
npm run build
```

Then wire it up:

1. Read the [normative specification](./SPEC.md): message formats, money units, security model.
2. Pick a store: `UpstashRestStore` for production, `MemoryStore` for tests and single-instance deployments.
3. Copy the wiring from [`adapters/next/`](./adapters/next) (gateway and Wompi webhook) or call the core directly.

```ts
import { UpstashRestStore } from 'c402-protocol/stores/upstash-rest'
import { settleAndGrant, StoreCreditLedger } from 'c402-protocol'

const store = new UpstashRestStore({ url: env.UPSTASH_URL, token: env.UPSTASH_TOKEN })
const result = await settleAndGrant({ store, ledger: new StoreCreditLedger(store), event })
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

## What is in this repository

| Path | Contents |
|---|---|
| `src/` | Framework-agnostic core: challenge lifecycle, settlement verification, ledger, pricing, HTTP headers, Wompi provider, stores |
| `tests/` | Conformance suite, including a non-atomic store the suite is required to reject |
| `adapters/next/` | Copy-paste wiring for Next.js App Router (not part of the published package) |
| `SPEC.md` | Normative protocol specification, v2.1 |
| `CONFORMANCE.md` | Implementer checklist for certifying your own stack |
| `CHANGELOG.md` | Protocol and implementation history |

## Why c402 exists

Colombia has world-class instant payment rails and no agent-native monetization layer. x402 gave stablecoin APIs autonomous payments; c402 brings the same capability to every Colombian API, using the money and rails people already use every day.

**Live deployment:** [Pequi API](https://xpequi.xyz) - Colombia's first public real-estate data API (31 endpoints, 276 barrios), monetized end to end with c402.

## Version 2.1: three defects fixed

Version 2.0 shipped a reference implementation whose claims did not match its code. Version 2.1 fixes all three and adds a regression test for each:

1. **The atomic claim was not atomic.** It documented `SET NX` but issued a plain `SET`, which always succeeds, so concurrent webhook deliveries could both grant credits. The store now sends a real `SET ... NX` and the suite asserts `NX=true` reaches the wire.
2. **The amount field contradicted its unit.** It was named `amount`, documented as COP, and compared against centavos. Now `amountCents`, integer minor units, with conversion helpers and a normative section.
3. **The gateway failed open.** It skipped payment when the store was down, serving paid resources for free. It now returns 503 while fail-closed is set.

Full detail in [CHANGELOG.md](./CHANGELOG.md).

## Roadmap

- **P5** - signed payment receipts (HMAC) for offline grant verification
- **P6** - multi-provider abstraction (Nequi direct, Bancolombia Transfer)
- **P7** - x402 interop bridge: one challenge, payable in COP *or* USDC

---

*Authored by [AI Architek](https://mcpvot.github.io) - MIT License*
