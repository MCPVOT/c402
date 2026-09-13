# Changelog

## 2.1.0

Security and correctness release. Three defects in the 2.0 reference implementation are fixed. Each one is now covered by a regression test.

### Fixed

1. **Non-atomic settlement claim (double grant).** `markAsPaidNx()` documented a `SET NX` claim but issued a plain `SET` through the Upstash REST helper. A plain `SET` always succeeds and always returns `OK`, so the function's `claim.ok` check could never fail: two concurrent webhook deliveries for the same nonce both passed the claim and both granted credits. The reference store now sends a genuine `SET key value EX ttl NX`, the guard is `result === 'OK'`, and `tests/stores.test.ts` asserts `NX=true` reaches the wire. `tests/settle.test.ts` drives 10 concurrent settlements and asserts exactly one grant.

2. **Amount unit ambiguity.** The stored field was named `amount` and documented "in COP" while being compared against the provider's `amount_in_cents` (centavos) and sent to checkout as `amount-in-cents`. Following the documentation literally would grant or demand 100x the intended value. The field is now `amountCents`, documented as integer minor units, with `src/money.ts` conversions and a normative section in SPEC.md.

3. **Gateway failed open.** The spec requires failing closed when the challenge store is unreachable, but the gateway fell back to `skip`, which let the request through unauthenticated for free. Access control is now a pure, tested function (`decideAccess`) that returns a 503 with `Retry-After` while `failClosed` is set, and the Next.js adapter returns 503 from both the balance and challenge-minting paths.

### Added

- Framework-agnostic core in `src/` with an injectable `ChallengeStore` and `CreditLedger`
- Conformance suite: 54 tests across money, pricing, settlement verification, settlement races, idempotency, store atomicity, HTTP headers, Wompi checksum handling and fail-closed decisions
- `CONFORMANCE.md` implementer checklist
- `adapters/next/` copy-paste wiring for Next.js App Router
- CI workflow: typecheck, tests, build

### Changed

- `reference/` removed; superseded by `src/` plus `adapters/next/`
- Settlement grace window is explicit (24 h default) rather than implicit
- Per-API-key cap on unpaid challenges to prevent store flooding
- `package.json` added: the repository is now installable, buildable and testable

## 2.0.0

- `verifySettlement`: amount and currency checked before granting credits (V1, V3)
- Atomic settle claim intended to replace the read-check-write race (V2) - see 2.1.0 item 1
- 30-day audit trail on settled challenges
- Subscription tier activation verifies the recorded price and COP currency
- Normative specification published
