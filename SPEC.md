# c402 - HTTP 402 Payment Protocol for Colombian Fiat Rails

> **Version:** 2.1 · **Status:** Draft standard, production-proven at xpequi.xyz
> **Author:** AI Architek (MCPVOT) · **License:** MIT
> **Companion of:** [x402](https://www.coinbase.com/developer-platform/discover/launches/x402) (Coinbase's stablecoin protocol). c402 is its fiat counterpart for Colombian payment rails.

---

## 1. Scope

c402 turns HTTP status **402 Payment Required** into a machine-readable payment negotiation layer for **Colombian fiat rails**: Wompi, PSE, Nequi, Daviplata and Bancolombia transfer. Where x402 lets agents pay in USDC on Base, c402 lets agents and applications pay in **COP** over the rails Colombians already use. No wallet, no crypto, no card.

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

## 2. Money representation (normative)

**All c402 amounts are integer minor units ("centavos") for COP, never peso values.**

| Field | Unit | Example |
|---|---|---|
| `amountCents` | integer centavos (1 COP = 100) | COP 2,500 => `250000` |
| provider `amount_in_cents` | integer centavos | `250000` |
| checkout `amount-in-cents` | integer centavos | `250000` |

A mismatch between the field name and the unit is a protocol error, not a rounding issue: an implementation that treats `amountCents` as pesos will either grant 100x the paid value or reject every valid payment. Protocol version 2.1 renamed the field from `amount` to `amountCents` for exactly this reason.

## 3. Protocol messages

### 3.1 The 402 challenge (server to client)

HTTP status `402` with the header `X-402-Challenge`:

```json
{
  "nonce": "b3f1c9e2-9a4d-4f61-8b3a-9f1e0d7c2a55",
  "amountCents": 250000,
  "currency": "COP",
  "calls": 50,
  "expiresAt": "2026-08-24T21:00:00.000Z",
  "paymentUrl": "https://checkout.wompi.co/p/?...&reference=c402_<nonce>"
}
```

The same object appears in the JSON body under `"c402"` for clients that do not read headers.

**Rule:** the provider `reference` MUST embed the nonce as `c402_<nonce>`. This is the join key between a settled transaction and its challenge.

### 3.2 Settlement (provider to server webhook)

Before granting anything, the server MUST, in this order:

1. Verify the webhook signature over the **raw body** with a constant-time comparison against the provider secret.
2. Reject any status that does not mean money moved. Settleable statuses are `APPROVED` and `COMPLETED`.
3. Resolve the challenge from the reference. Unknown nonce => no grant.
4. **Verify the settlement amount:** `transaction.amount_in_cents === challenge.amountCents`, integer equality. No tolerance, no rounding.
5. **Verify the currency** equals the challenge currency.
6. **Claim the nonce atomically** (see 4.1). If the claim fails, another delivery already granted: answer 200 and stop.
7. Only after a successful claim, grant the credits bound to the challenge's API key id.
8. Record the paid flag and the provider transaction id for audit.

Steps 4 to 7 MUST NOT be reordered. Verifying before claiming means an invalid payment never burns a nonce; claiming before granting means two concurrent deliveries can never both grant.

### 3.3 Client retry

The client repeats the original request with `X-402-Payment-Id: <nonce>`. The server MUST confirm the challenge exists, belongs to the caller's API key, is settled, and is inside its TTL before serving the response.

### 3.4 Late webhooks

Providers deliver webhooks after the challenge TTL expiries have passed. A server MUST accept settlement inside a grace window after `expiresAt` (RECOMMENDED: 24 hours) and MUST reject settlement beyond it.

## 4. Security requirements (normative)

| Threat | Requirement |
|---|---|
| Underpaid grant | Amount verification is MANDATORY server-side on every grant path. Never trust the checkout URL, the reference, or client claims. |
| Wrong-currency grant | Currency verification is MANDATORY. |
| Double grant / replay | **The settlement claim MUST be a true atomic set-if-absent (`SET key value NX`).** A plain `SET` or a `GET`->check->`SET` sequence is non-conformant: both allow two concurrent webhooks to grant twice. Implementations MUST ship a test that exercises N concurrent claims and asserts exactly one winner. |
| Forged webhook | Signature or checksum verification over the RAW body, constant-time comparison, 401 on failure. |
| Cross-user challenge theft | Challenges are bound to an API key at creation; the retry path re-checks ownership. |
| Nonce brute force | Nonces MUST be UUID v4 or stronger, single-use, TTL of 30 minutes or less. |
| Store flooding | Servers MUST cap unpaid challenges per API key (RECOMMENDED: 20) so one caller cannot fill the store. |
| Store outage | **Fail closed.** When the store is unreachable and the caller has no prepaid credits, respond `503` with `Retry-After`. Serving the request would convert an outage into free traffic. |
| Secret handling | Provider secrets live in environment or secret managers only. Never logged, never in URLs. |

### 4.1 Store conformance

A challenge store is c402-conformant when:

- `put` refuses to overwrite an existing nonce
- `claimOnce` returns `true` exactly once across N concurrent callers and `false` for all later callers
- expiry is enforced on read
- transport failure is reported so the caller can fail closed

`tests/stores.test.ts` in this repository implements exactly these checks, including a deliberate non-atomic store that the suite is required to reject.

## 5. Implementation notes (production-learned)

- **Idempotency keys on `transaction.id`, never `event.id`.** Wompi re-delivers webhooks with a new `event.id` for the same transaction; deduplicating on the event id grants credits twice.
- Wompi event checksum = `SHA-256(rawBody + eventsSecret)` as lowercase hex, compared with `timingSafeEqual`.
- Answer `200 {"received": true}` to every well-formed webhook, including duplicates and non-c402 references, or the provider keeps retrying.
- Terminal rejections (amount or currency mismatch) should answer `409`, not `5xx`: a 5xx invites retries of a payment that will never validate.
- Store challenges, the settlement marker and the credit ledger with TTLs. Keep the settled marker at least 30 days for audit and idempotency.
- Credit deduction should be one atomic `INCRBY` with a compensating rollback when the result goes negative.
- Response bodies and headers should be `Cache-Control: no-store`.

## 6. Reference implementation

This repository ships a runnable, framework-agnostic TypeScript implementation:

| Module | Purpose |
|---|---|
| `src/challenge.ts` | challenge lifecycle, settlement orchestration, retry authorisation |
| `src/settlement.ts` | amount, currency, status and grace-window verification |
| `src/ledger.ts` | prepaid credit ledger (atomic deduct with rollback) |
| `src/gateway-decision.ts` | pure allow / 402 / 503 decision, fail-closed |
| `src/http.ts` | `X-402-*` header encode, parse and validation |
| `src/providers/wompi.ts` | checksum verification, event normalisation, checkout URL |
| `src/stores/upstash-rest.ts` | production store, real `SET ... NX` |
| `src/stores/memory.ts` | in-process store for tests and single-instance deployments |
| `src/subscriptions.ts` | P3 API tier purchases over the same flow |
| `adapters/next/` | copy-paste wiring for Next.js App Router |

Install and verify:

```bash
npm install
npm test        # conformance suite
npm run build
```

## 7. Conformance

See [CONFORMANCE.md](./CONFORMANCE.md) for the implementer checklist and how to run the suite against your own store.

## 8. Changelog summary

Protocol 2.1 fixes three defects found in the 2.0 reference implementation: a claim that was documented as atomic but issued a plain `SET` (allowing a double grant), an amount field whose unit contradicted its use, and a gateway that failed open during store outages. Details in [CHANGELOG.md](./CHANGELOG.md).

## 9. Roadmap

- **P5** - signed payment receipts (HMAC) so third parties can verify grants offline
- **P6** - multi-provider abstraction (Nequi direct, Bancolombia Transfer)
- **P7** - x402 interop bridge: one challenge, payable in COP or USDC

## 10. Why c402 exists

Colombia has world-class instant payment rails and no agent-native monetization layer. x402 gave stablecoin APIs autonomous payments. c402 gives every Colombian API the same capability, using the money and rails 50 million Colombians already use.

---

*Normative specification, c402 v2.1. Reference implementation security-audited August 2026; findings V1-V5 plus the v2.1 defects are fixed and covered by the conformance suite.*
