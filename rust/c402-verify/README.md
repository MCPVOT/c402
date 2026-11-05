# c402-verify (Rust)

Offline verification of c402 payment receipts.

The TypeScript issuer (`src/receipt.ts` in the repository root) signs a settled challenge;
this crate verifies that receipt without calling the issuer. It carries no provider
dependency, no network code and no JSON parser: the canonical form is line-oriented, and
the two fields a caller must supply are the receipt and the shared secret.

```rust
use c402_verify::{verify, ReceiptPayload};

let payload = ReceiptPayload {
    nonce: "b3f1c9e2-9a4d-4f61-8b3a-9f1e0d7c2a55".into(),
    key_hash: "be29...e9d44".into(),
    amount_cents: 250_000,
    currency: "COP".into(),
    calls: 50,
    transaction_id: "tx-001".into(),
    paid_at: "2026-08-24T21:00:00.000Z".into(),
    expires_at: "2026-08-24T21:30:00.000Z".into(),
};

match verify(&payload, receipt_sig_hex, secret.as_bytes()) {
    Ok(()) => { /* the grant is real */ }
    Err(e) => { /* eprintln!("{e}") */ }
}
```

## What it proves, and what it does not

It proves the receipt was produced by someone holding the receipt secret, over exactly
those fields, for a challenge of that amount and call count. It does not prove the credits
are unspent: that requires the issuer's ledger.

## Signature

HMAC-SHA256 over:

```
c402-receipt-v1
nonce=...
keyHash=<sha256(apiKeyId) hex>
amountCents=...
currency=<upper case>
calls=...
transactionId=...
paidAt=...
expiresAt=...
```

No trailing newline. `tests/vector.rs` asserts the same signature hex as
`tests/receipt.test.ts`, so a change to the canonical form on either side fails both suites.

```bash
cargo test
```

Dependencies: `hmac`, `sha2`. Build is a few seconds; no system libraries.
