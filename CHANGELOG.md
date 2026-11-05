# Changelog

## 2.2.0

Second security and correctness release. Version 2.1 fixed the defects it knew about and then claimed the implementation was audited; re-auditing the 2.1 code found four more, three of which lose money. Each is fixed with a regression test. The protocol also gains the pieces an unattended agent needs: discovery, payment status, version negotiation and signed receipts (roadmap P5).

### Fixed

1. **A store outage was reported as an unknown challenge (payment dropped).** `settleAndGrant` treated any `null` from `store.get` as "no such challenge", and the webhook adapter answered that with `200 {"received": true}`, so the provider stopped retrying. During an Upstash outage a valid payment for a real challenge was acknowledged and lost. Settlement now distinguishes a miss from an outage and returns `store_unavailable`; the adapter answers `503` with `Retry-After`. Regression: `tests/defects.test.ts`, "regression: a store outage is not an unknown challenge".

2. **A failed credit grant burned the settlement claim (payment lost).** After `claimOnce` succeeded, a throwing `ledger.add` propagated out of `settleAndGrant` while the claim stayed taken. Every later delivery answered `claim_lost` -> `alreadyProcessed`: the buyer had paid, no credits existed, and no retry could ever grant them. The claim is now released on grant failure and `grant_failed` is retryable. `ChallengeStore` gained `releaseClaim` (idempotent; `DEL` on Upstash). Regression: "regression: a failed grant must not burn the nonce".

3. **The retry window was shorter than the settlement grace (credits unusable).** Settlement accepted webhooks up to 24 h after `expiresAt`, but `authorizeRetry` refused any challenge past its 30-minute TTL. A payment settling at TTL+5 min granted credits that the client could never spend. Verification and redemption now both use grace windows, and `C402Config.redemptionGraceSeconds` (default 24 h) must be at least `settlementGraceSeconds`. Regression: "regression: retry window must cover the settlement grace".

4. **Expired challenges counted against the per-key cap (caller self-lockout).** The outstanding counter was an `INCRBY` decremented only by settlement, so twenty abandoned challenges blocked a legitimate buyer until the counter's own TTL lapsed. The cap is now a timestamped per-key index pruned on read, and settlement clears the entry. Regression: "regression: abandoned challenges must not lock a key out".

5. **Malformed timestamps passed verification.** `Date.parse('garbage') < now` is `false`, so a corrupted `expiresAt` authorised a retry; `verifySettlement` skipped its grace check entirely on a non-finite date. Both now fail closed (`invalid_challenge` / `expired`). Regression: "settlement refuses a challenge with a malformed expiresAt".

6. **Nonce parsing accepted anything after `c402_`.** Slashes, spaces and dots reached the store as keys. Nonces must now match `[A-Za-z0-9_-]{8,128}`; anything else is an unknown challenge, not a sanitised one.

7. **The price ladder's `minCalls` column was decorative.** `calculatePrice` selected on `calls`, so editing one column silently made the table and the selector disagree. Selection is now by `minCalls`, and `assertPriceLadder()` validates contiguity, positive prices and `calls >= minCalls`.

8. **The Next.js adapters could not be copied out of the repository.** They imported `../../../src/...`, which resolves only inside this tree. They now import `c402-protocol`, and the webhook adapter maps every `SettleReason` (including the new retryable ones to `503`).

### Added

- **Signed receipts (P5).** `src/receipt.ts` signs a settled challenge as HMAC-SHA256 over a line-oriented canonical form; `rust/c402-verify` verifies the same bytes offline. Both suites assert one shared vector, so a receipt signed by TypeScript verifies in Rust.
- **Cross-platform by construction.** The text form normalises CRLF and a UTF-8 BOM in both languages (`verifyReceiptText` / `verify_receipt_text`), `.gitattributes` pins the repo to LF, and CI runs the TypeScript suite on Linux, macOS and Windows plus the Rust vector on Linux and Windows. Before this, a receipt file written on Windows failed verification for a line-ending reason.
- **Discovery document.** `src/discovery.ts` builds `/.well-known/c402.json`: unit, rails, TTLs, grace windows, receipt support, status endpoint.
- **Payment status contract.** `describePaymentStatus()` projects `pending | paid | expired | unknown` for `GET /c402/status/<nonce>`; `paid` survives expiry because the money moved, and `unknown` deliberately does not distinguish a missing nonce from a down store.
- **Version negotiation.** Challenges carry `version` and the `X-402-Version` header; a client must refuse an unknown major, and 2.0 payloads without a version are still accepted.
- `tests/defects.test.ts` (15 regression tests), `tests/receipt.test.ts` (11), `tests/discovery.test.ts` (9); suite is now 93 TypeScript tests plus 12 Rust tests.

### Changed

- Published layout is flat: `dist/index.js` instead of `dist/src/index.js`, with typed `exports` for `./pricing`, `./receipt`, `./discovery`, `./providers/wompi` and both stores.
- `tsconfig.json` builds `src/` only; `tsconfig.test.json` typechecks source plus tests (`npm run typecheck`).
- `package.json`: `repository`, `sideEffects: false`, `prepublishOnly` gate, `CHANGELOG.md` in `files`.

### Known limits

- The outstanding-challenge index is read-modify-write, so two simultaneous `createChallenge` calls can exceed the cap by one. It is an anti-flood mitigation, not an authorization gate; the spec sets it as RECOMMENDED for that reason.
- `StoreCreditLedger.deduct` is `INCRBY` plus a compensating rollback. It never ends negative under the tested interleavings, but a multi-region or high-concurrency deployment should use a Lua/EVAL store method.
- Receipts prove a grant happened; they do not prove a credit is unspent. That needs a spend-side counter, which is P6 work.

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
