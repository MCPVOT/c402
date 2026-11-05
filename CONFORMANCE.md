# c402 Conformance

Use this checklist to certify an implementation. Items marked **MUST** are enforced by the test suite in `tests/`.

## 1. Money

- [ ] **MUST** represent every amount as an integer in minor units (centavos for COP).
- [ ] **MUST** compare provider `amount_in_cents` to the stored amount with exact integer equality.
- [ ] **MUST NOT** apply rounding tolerance to settlement comparison.
- [ ] **MUST** price from a single ladder validated for contiguity (`assertPriceLadder`), not two selectors over the same table.

## 2. Challenge lifecycle

- [ ] **MUST** mint nonces of at least UUID v4 entropy.
- [ ] **MUST** match nonces against `[A-Za-z0-9_-]{8,128}` and treat anything else as an unknown challenge, never sanitise it into a key.
- [ ] **MUST** treat a nonce as single-use and enforce a TTL of 30 minutes or less.
- [ ] **MUST** refuse to overwrite an existing nonce on create.
- [ ] **MUST** bind the challenge to the authenticated API key id, never a client-supplied value.
- [ ] **MUST** cap unpaid challenges per API key (recommended 20).
- [ ] **MUST** stop counting a challenge toward that cap once it expires, or abandoned challenges lock the caller out.
- [ ] **MUST** fail closed on an unparseable `expiresAt` (reject, do not skip the check).

## 3. Settlement

- [ ] **MUST** verify the signature/checksum over the raw body with a constant-time comparison.
- [ ] **MUST** reject statuses that do not mean money moved (settleable: APPROVED, COMPLETED).
- [ ] **MUST** verify amount before claiming a nonce.
- [ ] **MUST** claim the nonce with a true atomic set-if-absent (`SET ... NX`).
- [ ] **MUST** grant credits only after a successful claim.
- [ ] **MUST** answer 200 for duplicate deliveries so the provider stops retrying.
- [ ] **MUST** accept late settlement inside the grace window and reject beyond it.
- [ ] **MUST** distinguish a store outage from an unknown challenge and answer `503 + Retry-After` for the outage.
- [ ] **MUST** release the claim and answer retryably when the credit grant fails after a successful claim.
- [ ] **MUST NOT** answer 200 for a delivery it did not actually settle or durably defer.

## 4. Retry and redemption

- [ ] **MUST** re-check ownership, settlement state and the redemption window on `X-402-Payment-Id`.
- [ ] **MUST** set the redemption window at least as long as the settlement grace, or a late valid payment becomes unspendable.
- [ ] **SHOULD** serve granted credits from the ledger as well as from the challenge, so a retry that lands after TTL still finds the balance.

## 5. Failure behaviour

- [ ] **MUST** fail closed (503 + Retry-After) when the store is unreachable and the caller has no credits.
- [ ] **MUST NOT** serve paid resources for free because of a store outage.
- [ ] **MUST** send `Cache-Control: no-store` on challenge and status responses.

## 6. Store conformance

- [ ] **MUST** return `true` exactly once across N concurrent `claimOnce` calls.
- [ ] **MUST** implement an idempotent `releaseClaim` so a failed grant is retryable.
- [ ] **MUST** report transport failure so the gateway can fail closed.
- [ ] **MUST** treat malformed stored values as missing, not as valid challenges.

## 7. Agent surface (recommended)

- [ ] **SHOULD** serve `/.well-known/c402.json` with unit, rails, TTLs, grace windows and receipt support.
- [ ] **SHOULD** serve `GET /c402/status/<nonce>` with `pending | paid | expired | unknown`, and not distinguish a missing nonce from a store outage.
- [ ] **SHOULD** include `version` in the challenge payload and `X-402-Version` in the response.
- [ ] **SHOULD** issue a `c402-receipt-v1` HMAC receipt on settlement; verify it with `src/receipt.ts` or `rust/c402-verify`.

## Running the suite

```bash
npm install
npm run typecheck
npm test
npm run build
cd rust/c402-verify && cargo test
```

The suite includes a deliberate non-atomic store (`tests/stores.test.ts`, "conformance suite catches a non-atomic store"). If your store passes every other check but that section does not flag the broken store, your copy of the suite was weakened: restore it.

`tests/defects.test.ts` holds the six regressions that make 2.2 meaningful: outage-vs-miss, claim release, redemption window, expired-challenge accounting, malformed timestamps and nonce charset. If those pass while your implementation still drops payments, the assertions were weakened, not satisfied.

To certify your own store, implement the `ChallengeStore` interface from `src/types.ts` (including `releaseClaim`) and run it through the assertions in `tests/stores.test.ts`.
