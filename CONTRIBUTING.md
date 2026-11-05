# Contributing

c402 is a protocol first and a library second. A change is judged by whether it
keeps the guarantees in [SPEC.md](./SPEC.md) true, not by whether it compiles.

## The loop

1. **Reproduce.** Write the defect or the missing behaviour as a failing test.
   `tests/defects.test.ts` is the model: each case names the defect it prevents.
2. **Fix.** Smallest change that makes it pass without weakening another
   guarantee.
3. **Keep the test.** A fix whose test also passes on the old code proves
   nothing.
4. **Run the gates.**

```bash
npm install
npm run typecheck
npm test
npm run build
cd rust/c402-verify && cargo test
```

5. **Open a PR.** Branch from `main`, never push to `main` directly. CI runs the
   TypeScript suite on Linux, macOS and Windows and the Rust vector on Linux and
   Windows.

## What needs a test

Any change to:

- the settlement order (verify before claim, grant after claim),
- the money unit or a conversion,
- the claim primitive or `releaseClaim`,
- the retry/redemption window,
- the receipt canonical form or its version tag,
- an error reason that an adapter maps to an HTTP status.

A change to the receipt canonical form must update **both**
`tests/receipt.test.ts` and `rust/c402-verify/tests/vector.rs`; they assert the
same signature hex on purpose.

## Style

- Plain words, short sentences, no marketing in code comments.
- Comments explain *why* a rule exists, especially where the obvious
  implementation is wrong (a plain `SET`, a counter that never expires).
- No personal names in commits, headers or docs. Use `MCPVOT`.
- No secrets, real transaction ids or customer data in tests.

## Reporting a security issue

Do not open a public issue. See [SECURITY.md](./SECURITY.md).
