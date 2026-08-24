# c402 Protocol

**The Colombian HTTP 402 fiat payment standard for AI agents and pay-per-call APIs.**

[![Status](https://img.shields.io/badge/status-draft_standard-00e5ff?style=flat-square&labelColor=0d1117)](./SPEC.md)
[![License: MIT](https://img.shields.io/badge/license-MIT-00ff88?style=flat-square&labelColor=0d1117)](./LICENSE)
[![Production](https://img.shields.io/badge/production--proven-xpequi.xyz-00ff88?style=flat-square&labelColor=0d1117)](https://xpequi.xyz)
[![Companion](https://img.shields.io/badge/companion-x402_(Base_USDC)-8b5cf6?style=flat-square&labelColor=0d1117)](https://www.coinbase.com/developer-platform/discover/launches/x402)

> HTTP 402 sat unused for 30 years. [x402](https://x402.org) gave it stablecoins.
> **c402 gives it Colombia** — Wompi, PSE, Nequi, Daviplata, Bancolombia.
>
> No wallet. No crypto. No card. The rails 50 million Colombians already use.

---

## The flow

```
Client                          Server (API)                    Wompi
  │  GET /v1/resource              │                              │
  │ ─────────────────────────────▶ │                              │
  │  402 + X-402-Challenge         │                              │
  │ ◀───────────────────────────── │  challenge: nonce, COP, TTL  │
  │                                │                              │
  │  open paymentUrl (PSE / Nequi / card / Bancolombia) ─────────▶│
  │                                │  webhook: transaction.updated│
  │                                │ ◀────────────────────────────│
  │                                │  ✓ verify amount + currency  │
  │                                │  ✓ atomic settle (SET NX)    │
  │  retry + X-402-Payment-Id      │  ✓ grant credits             │
  │ ─────────────────────────────▶ │                              │
  │  200 + data                    │                              │
  │ ◀───────────────────────────── │                              │
```

## Quick start

1. Read the [normative specification](./SPEC.md) — message formats, security model, requirements table.
2. Copy the hardened reference implementation from [`reference/`](./reference) (TypeScript · Next.js · Upstash Redis):
   - [`challenge.ts`](./reference/challenge.ts) — challenge lifecycle, atomic settle, settlement verification
   - [`gateway.ts`](./reference/gateway.ts) — drop-in wrapper for any API route
   - [`wompi-webhook.route.ts`](./reference/wompi-webhook.route.ts) — hardened Wompi webhook
   - [`ledger.ts`](./reference/ledger.ts) — atomic prepaid-credit ledger
3. Wire your provider secrets (`WOMPI_EVENTS_SECRET`, `WOMPI_PUBLIC_KEY`) via env — never in code.

## Non-negotiables (from the spec)

| ✔ | Rule |
|---|---|
| ✅ | Verify settled **amount AND currency** server-side before granting anything |
| ✅ | Atomic settle claim (SET NX) — concurrent webhooks must never double-grant |
| ✅ | Webhook signature with timing-safe comparison over the RAW body |
| ✅ | Idempotency keyed on `transaction.id` — never `event.id` |
| ✅ | Challenges bound to an API-key ID, UUID v4 nonce, TTL ≤ 30 min |
| ✅ | Fail closed when the challenge store is unavailable |

## Why c402 exists

Colombia has world-class instant payment rails and zero agent-native monetization layer. x402 solved autonomous payments for stablecoin APIs; c402 brings the same superpower to every Colombian API using the money people actually use.

**Live deployment:** [Pequi API](https://xpequi.xyz) — Colombia's first public real-estate data API (31 endpoints, 276 barrios), monetized end-to-end with c402. Security-audited August 2026; findings V1–V5 fixed and documented in the spec.

## Roadmap

- **P5** — signed payment receipts (HMAC) for offline grant verification
- **P6** — multi-provider abstraction (Nequi direct, Bancolombia Transfer)
- **P7** — x402 interop bridge: one challenge, payable in COP *or* USDC

---

*Authored by [AI Architek](https://mcpvot.github.io) · MIT License*
