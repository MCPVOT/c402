# c402 — The Colombian HTTP 402 Payment Protocol

> **Version:** 2.0 · **Status:** Draft standard, production-proven at xpequi.xyz
> **Author:** AI Architek (MCPVOT) · **License:** MIT
> **Companion of:** [x402](https://www.coinbase.com/developer-platform/discover/launches/x402) (Coinbase's stablecoin protocol) — c402 is its fiat counterpart for Colombian payment rails.

---

## 1. What c402 is

c402 turns HTTP status code **402 Payment Required** into a machine-readable payment negotiation layer for **Colombian fiat rails** — Wompi, PSE, Nequi, Daviplata, Bancolombia transfer. Where x402 lets AI agents pay in USDC on Base, c402 lets agents and apps pay in **COP** with the local rails Colombians already use — no wallet, no crypto, no card.

One HTTP request. A 402 answer with a payment challenge. Pay by Wompi link. Retry with a payment ID. Data flows.

```
Client                          Server (API)                    Wompi
  │  GET /v1/properties            │                              │
  │ ─────────────────────────────▶ │                              │
  │  402 + X-402-Challenge         │   (challenge stored: nonce,  │
  │ ◀───────────────────────────── │    amount COP, TTL, key-id)  │
  │                                │                              │
  │  open paymentUrl ────────────────────────────────────────────▶│
  │  (Wompi checkout: PSE / Nequi / card / Bancolombia)           │
  │                                │   webhook: transaction.updated│
  │                                │ ◀────────────────────────────│
  │                                │   verify amount+currency     │
  │                                │   atomic settle (SET NX)     │
  │  retry + X-402-Payment-Id      │   grant credits              │
  │ ─────────────────────────────▶ │                              │
  │  200 + data                    │                              │
  │ ◀───────────────────────────── │                              │
```

## 2. Protocol messages

### 2.1 The 402 challenge (server → client)

HTTP status `402` with header:

```
X-402-Challenge: {
  "nonce": "b3f1c9e2-…",          // UUID v4, single-use
  "amount": 2500,                  // integer COP
  "currency": "COP",
  "calls": 50,                     // what the payment unlocks
  "expiresAt": "2026-08-24T21:00:00Z",  // RFC 3339; typical TTL 30 min
  "paymentUrl": "https://checkout.wompi.co/p/?…&reference=c402_<nonce>"
}
```

The same object is mirrored in the JSON body under `"c402"` for clients that don't read headers.

**Rule:** the `reference` sent to the payment provider MUST embed the nonce (`c402_<nonce>`). This is the join key between the settled transaction and the challenge.

### 2.2 Settlement (provider → server webhook)

The server MUST, before granting anything:

1. Verify the webhook signature/checksum against the provider secret using a constant-time comparison.
2. Accept only `status ∈ {APPROVED}` (treat PENDING/VOIDED/DECLINED as no-op).
3. Load the challenge by nonce; reject unknown nonces with 404.
4. **Verify settlement amount:** `transaction.amount_in_cents === challenge.amount` (integer comparison). Reject mismatches with `409`.
5. **Verify currency:** `transaction.currency === "COP"`. Reject others with `409`.
6. **Atomic claim:** mark the challenge paid via a single-use Redis operation (`SET NX` on `c402:paid:<nonce>`, TTL ≥ 30 days for audit). If the claim fails, another processor already granted — return 200 idempotently.
7. Only then grant credits/unlocks, keyed to the API-key ID bound inside the challenge.

### 2.3 Client retry (client → server)

The client retries the original request with:

```
X-402-Payment-Id: <nonce>
```

Server verifies: challenge exists, belongs to the caller's API key, not expired, and credits balance > 0 (atomic decrement). On success the normal response is returned.

## 3. Security model (normative)

| Threat | Requirement |
|---|---|
| Underpaid grant | Amount verification is MANDATORY server-side on every grant path. Never trust the checkout URL, the reference, or client claims. |
| Wrong-currency grant | Currency check is MANDATORY (`COP`). |
| Replay / double-grant | Settlement claim MUST be atomic (single-use SET NX). GET→check→SET sequences are forbidden. Webhook dedup keys use `transaction.id`, never `event.id` (providers re-send events with new event IDs). |
| Forged webhooks | Signature/checksum MUST be verified with timing-safe comparison over the RAW body. Missing signature → 401. |
| Cross-user challenge theft | Challenges are bound to an API-key ID at creation; retry path verifies ownership. |
| Nonce brute force | Nonces MUST be UUID v4 or stronger; single-use; short TTL (≤30 min). |
| Provider outage | If the challenge store is unavailable, fail closed to rate limiting — never open. |
| Secret handling | Provider secrets live only in env/secrets manager; never logged, never in URLs. |

## 4. Implementation notes (production-learned)

- **Idempotency key = transaction.id**, not event.id. Wompi re-sends webhooks with a *new* `event.id` but same `transaction.id`; deduping by event double-grants credits.
- Wompi checksum = SHA-256(rawBody + eventsSecret), hex — compare with `timingSafeEqual`.
- Store challenges and credit ledgers in Redis with TTLs; keep a ≥30-day audit copy of every settled challenge (`c402:paid:*`).
- Credit deduction must be atomic (`INCRBY` + post-check ≥ 0 or Lua script).
- Respond `200 {"received": true}` to ALL well-formed webhooks — even duplicates — or the provider will keep retrying.

## 5. Reference implementation

Production code (TypeScript / Next.js / Upstash Redis / Prisma):

- `lib/c402/challenge.ts` — challenge lifecycle, atomic settle, settlement verification
- `lib/c402/gateway.ts` — drop-in wrapper for v1 API routes
- `app/api/payments/webhook/wompi/route.ts` — hardened Wompi webhook
- `lib/credits/ledger.ts` — atomic prepaid-credit ledger

Live deployment: https://xpequi.xyz (Pequi API — Colombia's first public real-estate data API, 31 endpoints, 276 barrios).

## 6. Roadmap

- **P4 (current):** subscriptions (tier unlocks, 30-day periods) over the same 402 flow
- **P5:** signed payment receipts (HMAC) so third parties can verify grants offline
- **P6:** multi-provider abstraction (add Bancolombia Transfer / Nequi direct)
- **P7:** interop bridge with x402 — one challenge, pay in COP or USDC

## 7. Why it matters

Colombia has world-class instant payment rails and zero agent-native monetization layer. c402 gives every Colombian API the same autonomous-payment superpower x402 gave stablecoin APIs — using the money and rails that 50 million Colombians already use every day.

---

*This document is the normative c402 v2 specification. Reference implementation security-audited August 2026 (findings V1–V5 fixed in commits to MCPVOT/pequi).*
