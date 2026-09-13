# Adapters

Thin wiring examples that connect the tested core (`src/`) to a web framework.

These files are **not** part of the compiled npm package and are excluded from the
root `tsconfig.json` (they import `next/server`). Copy them into your app and
adapt the imports.

The important part is what they delegate to:

- `decideAccess()` decides allow / 402 / 503 and enforces fail-closed behaviour
- `createChallenge()` mints the nonce, price and TTL
- `verifySettlement()` checks amount, currency and status before any grant
- `settleAndGrant()` performs the atomic claim and the single grant

If you reimplement any of that ordering by hand, run `npm test` in your fork:
the conformance suite is what catches a non-atomic store.
