---
type: audit
status: closed
topic: [c402, protocol, security]
audit_of: MCPVOT/c402 @ 79142bc (v2.1.0)
result: v2.2.0
auditor: MCPVOT worker seat (mcpvot)
---

# c402 2.2 audit

Scope: the whole tree at commit `79142bc` ("c402 v2.1.0: fix three security/correctness
defects, ship tested core"), which was itself advertised as audited. Method: read every
source and test file, then reproduce each suspected defect as a failing assertion before
changing anything. Every finding below has probe output pasted from a run on this
implementation.

Baseline before any change: `npm test` -> 54 passed. That is the point: all six defects
below existed while a green suite said the implementation was conformant.

## Summary

| ID | Defect | Severity | Money at risk | Reachable |
|---|---|---|---|---|
| A1 | Store outage reported as `unknown_challenge`; webhook answers 200 | Critical | Yes: paid, never granted | Yes: `settleAndGrant` -> every adapter |
| A2 | Failed credit grant burns the settlement claim | Critical | Yes: paid, never granted, no retry possible | Yes: any ledger error |
| A3 | Retry window (30 min TTL) shorter than settlement grace (24 h) | High | Yes: granted, unspendable | Yes: any webhook after TTL |
| A4 | Expired challenges never leave the per-key cap | High | No: availability only | Yes: 20 abandoned challenges |
| A5 | Unparseable `expiresAt` fails open on retry and settlement | Medium | No | Yes: corrupted record |
| A6 | Nonce parsing accepts path-like values after `c402_` | Medium | No | Yes: `parseNonceFromReference` |
| A7 | Price ladder `minCalls` decorative; two selectors over one table | Low | No | Yes: `calculatePrice` |
| A8 | Next.js adapters import `../../../src/...`, unusable outside the repo | Low | No | Yes: docs told implementers to copy them |
| A9 | `SideEffects`/`exports`/`files` incomplete; `dist/src/...` paths | Low | No | Packaging |

## Proof (probe output, before the fix)

Runner: `npx vitest run tests/zz-audit-probe.test.ts` against 79142bc.

```
P1 result -> c402: too many unpaid challenges (3/3)
P2 result -> {"ok":false,"reason":"unknown_challenge","challenge":null}
P3 challenge -> 2026-08-24T11:59:56.000Z
P3 retry auth -> {"ok":false,"reason":"unpaid"}
P4 threw -> true retry -> {"ok":false,"reason":"claim_lost",...}
P5 auth -> {"ok":true}
```

- **P1 = A4.** Three challenges minted with `maxOutstandingPerKey: 3` and a 1 s TTL.
  After they expired the counter still read 3/3 and the next legitimate purchase threw.
- **P2 = A1.** With `store.available === false` and `get()` returning null, settlement
  reported `unknown_challenge`. The adapter's `default:` branch answers
  `200 {"received": true, "deferred": true}`, so the provider stops retrying and the
  payment is gone.
- **P3 = A3.** A challenge that expired seconds earlier is refused by `authorizeRetry`
  while `verifySettlement` accepts settlement for another 24 h.
- **P4 = A2.** A ledger that throws after the claim leaves the claim taken. The retry
  with a healthy ledger answered `claim_lost`; the buyer's payment can never become
  credits. The `SettleReason` union even had no value for this case.
- **P5 = A5.** `Date.parse('not-a-date') < now` is `false`, so a corrupted record passed
  retry authorisation. `verifySettlement` skipped its grace check entirely when the date
  was non-finite.

## Fixes

| ID | Change | Regression test |
|---|---|---|
| A1 | `settleAndGrant` returns `store_unavailable` when the lookup fails or the store reports itself unavailable; adapters answer 503 + Retry-After | `defects.test.ts` "a store outage is not an unknown challenge" |
| A2 | `ChallengeStore.releaseClaim` (idempotent `DEL`); on grant failure the claim is released and `grant_failed` is returned | "a failed grant must not burn the nonce" |
| A3 | `C402Config.redemptionGraceSeconds` (default 24 h) applied in `authorizeRetry`; documented as `>= settlementGraceSeconds` | "retry window must cover the settlement grace" |
| A4 | Outstanding cap is a timestamped per-key index pruned on read; settlement clears its entry | "abandoned challenges must not lock a key out" |
| A5 | Non-finite `expiresAt` -> `invalid_challenge` / `expired` | "settlement refuses a challenge with a malformed expiresAt" |
| A6 | `NONCE_PATTERN = /^[A-Za-z0-9_-]{8,128}$/`, reject not sanitise | "reference parsing is a closed set" |
| A7 | `calculatePrice` selects by `minCalls`; `assertPriceLadder()` validates the table | `pricing.test.ts` ladder tests |
| A8 | Adapters import `c402-protocol`; webhook maps every `SettleReason`, retryable ones to 503 | adapter review + CONFORMANCE step |
| A9 | Flat `dist/`, typed `exports`, `repository`, `sideEffects: false`, `prepublishOnly` | `npm run build` + `npm pack` inspection |

## Additions in 2.2

- `src/receipt.ts` - HMAC-SHA256 receipts over a line-oriented canonical form (P5).
- `rust/c402-verify` - offline verifier, 12 tests, same byte-identical vector as TS.
- `src/discovery.ts` - `/.well-known/c402.json` builder and `describePaymentStatus()`.
- `version` in the challenge payload + `X-402-Version`, with major-version refusal.

## Checked and found clean

- Settlement verification order (status -> amount -> currency -> grace) was correct in 2.1.
- `claimOnce` on both stores is genuinely `SET NX`; the conformance suite does catch a
  non-atomic store (verified by running it against the deliberate `NaiveStore`).
- Wompi checksum: raw body, lowercase hex, length-checked, `timingSafeEqual`. Malformed
  input returns false without throwing.
- `MemoryStore.claimOnce` has no `await` between read and write, so it is atomic on
  Node's single thread; this is stated in the code and holds under the 25-way test.
- Ledger deduction never ends negative under concurrent deducts in the tested
  interleavings (added as a test rather than left as a comment).
- No secret is logged, put in a URL, or written to a receipt: receipts carry
  `sha256(apiKeyId)`.

## Known limits (not defects, but do not overclaim)

- The outstanding index is read-modify-write; two simultaneous `createChallenge` calls can
  overshoot the cap by one. Anti-flood is RECOMMENDED in the spec for this reason.
- `deduct` is `INCRBY` + compensating rollback; high-concurrency deploys should use Lua.
- A receipt proves a grant happened, not that credits remain unspent.
- The Rust crate verifies receipts only; it is not a second full implementation.
- Adapters are excluded from the repo's typecheck because `next` is not a dependency;
  they are compile-checked only when copied into an app with `c402-protocol` installed.

## Verification after the fix

```
npm run typecheck   -> exit 0
npm test            -> 93 passed (11 files)
npm run build       -> dist/index.js, dist/receipt.js, dist/discovery.js
cargo test          -> 12 passed (c402-verify)
```
