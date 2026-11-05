# c402 - HTTP 402 Payment Protocol for Colombian Fiat Rails

> **Version:** 2.2 · **Status:** Draft standard, production-proven at xpequi.xyz
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
  |  200 + data (+ receipt)      |                              |
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

HTTP status `402` with the header `X-402-Challenge` and `X-402-Version: 2.2`:

```json
{
  "version": "2.2",
  "nonce": "b3f1c9e2-9a4d-4f61-8b3a-9f1e0d7c2a55",
  "amountCents": 250000,
  "currency": "COP",
  "calls": 50,
  "expiresAt": "2026-08-24T21:00:00.000Z",
  "paymentUrl": "https://checkout.wompi.co/p/?...&reference=c402_<nonce>",
  "statusUrl": "/c402/status/b3f1c9e2-9a4d-4f61-8b3a-9f1e0d7c2a55"
}
```

The same object appears in the JSON body under `"c402"` for clients that do not read headers. `statusUrl` is RECOMMENDED: an agent that has started a payment needs a way to observe it without spending credits.

**Rule:** the provider `reference` MUST embed the nonce as `c402_<nonce>`. This is the join key between a settled transaction and its challenge.

**Rule:** nonces MUST match `[A-Za-z0-9_-]{8,128}`. A nonce becomes a storage key and travels through a provider reference, so a value outside that set MUST be treated as an unknown challenge rather than sanitised.

**Rule:** a client MUST refuse a challenge whose `version` major number it does not implement, and MUST tolerate an absent `version` as 2.0.

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

**Rule (2.2): a store outage MUST NOT be reported as an unknown challenge.** When the challenge cannot be read because the store is unreachable, the server MUST answer `503` with `Retry-After`, not `200` and not a grant. Answering 200 tells the provider the delivery was handled, so a payment for a challenge that does exist is dropped permanently.

**Rule (2.2): a failed grant MUST release the claim.** If the credits cannot be written after a successful claim, the server MUST release the claim and signal a retryable failure. Leaving the claim taken means the provider's retries are answered "already processed" while the buyer never received credits.

### 3.3 Client retry

The client repeats the original request with `X-402-Payment-Id: <nonce>`. The server MUST confirm the challenge exists, belongs to the caller's API key, is settled, and is inside its **redemption window** (3.4) before serving the response.

### 3.4 Late webhooks and the redemption window

Providers deliver webhooks after challenge TTL expiry. A server MUST accept settlement inside a grace window after `expiresAt` (RECOMMENDED: 24 hours) and MUST reject settlement beyond it.

**Rule (2.2): the redemption window MUST be at least as long as the settlement grace.** A challenge settled at TTL+23h is inside the settlement grace; if the retry path refused it at TTL+1s, the buyer's money would be taken and the credits unusable. Recommended: both windows 24 hours, configurable, with `redemptionGraceSeconds >= settlementGraceSeconds`.

A server SHOULD also present purchased credits through the credit ledger rather than only through the challenge, so a client whose retry lands on a fresh 402 can still spend an already-granted balance.

### 3.5 Discovery (server to client, optional but recommended)

A deployment SHOULD serve `GET /.well-known/c402.json`:

```json
{
  "protocol": "c402",
  "version": "2.2",
  "currency": "COP",
  "challenge": { "header": "X-402-Challenge", "ttlSeconds": 1800,
                 "redemptionGraceSeconds": 86400, "maxOutstandingPerKey": 20 },
  "settlement": { "settleableStatuses": ["APPROVED", "COMPLETED"],
                  "graceSeconds": 86400, "claim": "SET NX" },
  "receipt": { "supported": true, "algorithm": "HMAC-SHA256", "version": "c402-receipt-v1" },
  "rails": ["wompi", "pse", "nequi", "daviplata", "bancolombia_transfer"],
  "endpoints": { "status": "/c402/status/{nonce}", "discovery": "/.well-known/c402.json" }
}
```

This is what makes the protocol agent-native rather than agent-adjacent: an unattended client can learn the price unit, the rails, whether receipts exist, and how to poll, without being hand-coded against one vendor.

### 3.6 Payment status (server to client, optional but recommended)

`GET /c402/status/<nonce>` SHOULD return:

```json
{ "nonce": "...", "status": "pending|paid|expired|unknown",
  "amountCents": 250000, "currency": "COP", "calls": 50,
  "createdAt": "...", "expiresAt": "...", "transactionId": null }
```

`paid` is reported even after expiry: the money moved. `expired` means unpaid and past TTL. `unknown` covers both a missing nonce and an unavailable store; a status endpoint MUST NOT distinguish those two, because that distinction is a store-probing oracle. Status responses MUST be `Cache-Control: no-store`.

## 4. Security requirements (normative)

| Threat | Requirement |
|---|---|
| Underpaid grant | Amount verification is MANDATORY server-side on every grant path. Never trust the checkout URL, the reference, or client claims. |
| Wrong-currency grant | Currency verification is MANDATORY. |
| Double grant / replay | **The settlement claim MUST be a true atomic set-if-absent (`SET key value NX`).** A plain `SET` or a `GET`->check->`SET` sequence is non-conformant: both allow two concurrent webhooks to grant twice. Implementations MUST ship a test that exercises N concurrent claims and asserts exactly one winner. |
| Forged webhook | Signature or checksum verification over the RAW body, constant-time comparison, 401 on failure. |
| Cross-user challenge theft | Challenges are bound to an API key at creation; the retry path re-checks ownership. |
| Nonce brute force | Nonces MUST be UUID v4 or stronger, single-use, TTL of 30 minutes or less. |
| Store flooding | Servers MUST cap unpaid challenges per API key (RECOMMENDED: 20) so one caller cannot fill the store. **Expired challenges MUST stop counting**, or abandoned challenges lock a paying caller out. |
| Store outage | **Fail closed.** When the store is unreachable and the caller has no prepaid credits, respond `503` with `Retry-After`. Serving the request would convert an outage into free traffic. |
| Lost payment | A settlement that cannot be granted MUST be retryable (release the claim), never acknowledged as processed. |
| Forged receipt | A receipt MUST be HMAC-SHA256 over the canonical field list in 5.1 with a server-held secret, constant-time comparison, and a version tag. |
| Secret handling | Provider secrets live in environment or secret managers only. Never logged, never in URLs. |

### 4.1 Store conformance

A challenge store is c402-conformant when:

- `put` refuses to overwrite an existing nonce
- `claimOnce` returns `true` exactly once across N concurrent callers and `false` for all later callers
- `releaseClaim` is idempotent and removes a claim so a retry can settle
- expiry is enforced on read
- transport failure is reported so the caller can fail closed

`tests/stores.test.ts` in this repository implements exactly these checks, including a deliberate non-atomic store that the suite is required to reject.

## 5. Implementation notes (production-learned)

- **Idempotency keys on `transaction.id`, never `event.id`.** Wompi re-delivers webhooks with a new `event.id` for the same transaction; deduplicating on the event id grants credits twice.
- Wompi event checksum = `SHA-256(rawBody + eventsSecret)` as lowercase hex, compared with `timingSafeEqual`.
- Answer `200 {"received": true}` to every well-formed webhook, including duplicates and non-c402 references, or the provider keeps retrying. This applies to handled outcomes only: an outage or a failed grant is a `503`, because those deliveries are not handled.
- Terminal rejections (amount or currency mismatch) should answer `409`, not `5xx`: a 5xx invites retries of a payment that will never validate.
- Store challenges, the settlement marker and the credit ledger with TTLs. Keep the settled marker at least 30 days for audit and idempotency.
- Credit deduction should be one atomic `INCRBY` with a compensating rollback when the result goes negative.
- Response bodies and headers should be `Cache-Control: no-store`.

### 5.1 Signed receipts (2.2, optional)

A server MAY return a receipt on the retry response and on the status endpoint. The signature covers a line-oriented canonical form, not JSON, because JSON has several valid encodings and two languages that serialise differently would produce different signatures for the same receipt.

```
c402-receipt-v1
nonce=<nonce>
keyHash=<sha256(apiKeyId) hex>
amountCents=<integer minor units>
currency=<ISO 4217, upper case>
calls=<integer>
transactionId=<provider transaction id>
paidAt=<RFC 3339>
expiresAt=<challenge expiry, RFC 3339>
```

`sig` = lowercase hex `HMAC-SHA256(secret, canonical)`; no trailing newline. `v` carries the version tag and is not part of the input. Receipts carry `sha256(apiKeyId)`, never the key.

**Rule (2.2): the canonical form is LF-only.** A reader of the text form MUST strip a UTF-8 BOM and normalise CRLF or lone CR to LF before verifying. Windows editors, PowerShell redirection and `core.autocrlf=true` all produce CRLF; a receipt that fails because of a line ending is a portability defect, not a signature failure. The repository enforces LF in `.gitattributes`.

Reference implementations: `src/receipt.ts` (issuer, verifier, and `verifyReceiptText`) and `rust/c402-verify` (offline verifier, `verify_receipt_text`). Both assert the same test vector, including CRLF and BOM variants, so a receipt signed by one verifies in the other on either platform.

## 6. Reference implementation

This repository ships a runnable, framework-agnostic TypeScript implementation, plus a Rust verifier:

| Module | Purpose |
|---|---|
| `src/challenge.ts` | challenge lifecycle, settlement orchestration, retry authorisation |
| `src/settlement.ts` | amount, currency, status and grace-window verification |
| `src/ledger.ts` | prepaid credit ledger (atomic deduct with rollback) |
| `src/gateway-decision.ts` | pure allow / 402 / 503 decision, fail-closed |
| `src/http.ts` | `X-402-*` header encode, parse and validation |
| `src/discovery.ts` | discovery document and payment-status projection |
| `src/receipt.ts` | signed payment receipts (sign and verify) |
| `src/providers/wompi.ts` | checksum verification, event normalisation, checkout URL |
| `src/stores/upstash-rest.ts` | production store, real `SET ... NX`, `releaseClaim` |
| `src/stores/memory.ts` | in-process store for tests and single-instance deployments |
| `src/subscriptions.ts` | P3 API tier purchases over the same flow |
| `rust/c402-verify/` | dependency-light Rust verifier for receipts |
| `adapters/next/` | copy-paste wiring for Next.js App Router |

Install and verify:

```bash
npm install
npm test        # conformance suite
npm run build
cd rust/c402-verify && cargo test   # cross-language receipt vector
```

## 7. Conformance

See [CONFORMANCE.md](./CONFORMANCE.md) for the implementer checklist and how to run the suite against your own store.

## 8. Changelog summary

Protocol 2.1 fixed three defects in the 2.0 reference implementation: a claim documented as atomic that issued a plain `SET` (double grant), an amount field whose unit contradicted its use, and a gateway that failed open during store outages.

Protocol 2.2 fixes four defects found by re-auditing 2.1, each with a regression test: a store outage reported as an unknown challenge (dropped payment), a failed grant that burned the claim (payment lost), a retry window shorter than the settlement grace (credits granted but unusable), and an outstanding-challenge counter that never released expired challenges (caller self-lockout). It adds discovery, a status contract, version negotiation and signed receipts. Details in [CHANGELOG.md](./CHANGELOG.md) and [docs/AUDIT-2.2.md](./docs/AUDIT-2.2.md).

## 9. Roadmap

- ~~**P5** - signed payment receipts (HMAC) so third parties can verify grants offline~~ (shipped in 2.2)
- **P6** - multi-provider abstraction (Nequi direct, Bancolombia Transfer)
- **P7** - x402 interop bridge: one challenge, payable in COP or USDC

## 10. Why c402 exists

Colombia has world-class instant payment rails and no agent-native monetization layer. x402 gave stablecoin APIs autonomous payments. c402 gives every Colombian API the same capability, using the money and rails 50 million Colombians already use.

---

*Normative specification, c402 v2.2. Reference implementation security-audited August 2026 and November 2026; findings V1-V5, the v2.1 defects and the v2.2 defects are fixed and covered by the conformance suite.*
