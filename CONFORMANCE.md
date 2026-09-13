# c402 Conformance

Use this checklist to certify an implementation. Items marked **MUST** are enforced by the test suite in `tests/`.

## 1. Money

- [ ] **MUST** represent every amount as an integer in minor units (centavos for COP).
- [ ] **MUST** compare provider `amount_in_cents` to the stored amount with exact integer equality.
- [ ] **MUST NOT** apply rounding tolerance to settlement comparison.

## 2. Challenge lifecycle

- [ ] **MUST** mint nonces of at least UUID v4 entropy.
- [ ] **MUST** treat a nonce as single-use and enforce a TTL of 30 minutes or less.
- [ ] **MUST** refuse to overwrite an existing nonce on create.
- [ ] **MUST** bind the challenge to the authenticated API key id, never a client-supplied value.
- [ ] **MUST** cap unpaid challenges per API key (recommended 20).

## 3. Settlement

- [ ] **MUST** verify the signature/checksum over the raw body with a constant-time comparison.
- [ ] **MUST** reject statuses that do not mean money moved (settleable: APPROVED, COMPLETED).
- [ ] **MUST** verify amount before claiming a nonce.
- [ ] **MUST** claim the nonce with a true atomic set-if-absent (`SET ... NX`).
- [ ] **MUST** grant credits only after a successful claim.
- [ ] **MUST** answer 200 for duplicate deliveries so the provider stops retrying.
- [ ] **MUST** accept late settlement inside the grace window and reject beyond it.

## 4. Failure behaviour

- [ ] **MUST** fail closed (503 + Retry-After) when the store is unreachable and the caller has no credits.
- [ ] **MUST NOT** serve paid resources for free because of a store outage.
- [ ] **MUST** send `Cache-Control: no-store` on challenge responses.

## 5. Store conformance

- [ ] **MUST** return `true` exactly once across N concurrent `claimOnce` calls.
- [ ] **MUST** report transport failure so the gateway can fail closed.
- [ ] **MUST** treat malformed stored values as missing, not as valid challenges.

## Running the suite

```bash
npm install
npm test
```

The suite includes a deliberate non-atomic store (`tests/stores.test.ts`, "conformance suite catches a non-atomic store"). If your store passes every other check but that section does not flag the broken store, your copy of the suite was weakened: restore it.

To certify your own store, implement the `ChallengeStore` interface from `src/types.ts` and run it through the assertions in `tests/stores.test.ts`.
