# Security policy

c402 moves money. A defect here is not a broken page; it is a payment that is
granted twice, granted to the wrong caller, or taken and never granted.

## Supported versions

| Version | Supported |
|---|---|
| 2.2.x | yes |
| 2.1.x | no — four money-losing defects, see [docs/AUDIT-2.2.md](./docs/AUDIT-2.2.md) |
| 2.0.x and earlier | no |

## Reporting a vulnerability

Use GitHub's private vulnerability reporting:

**https://github.com/MCPVOT/c402/security/advisories/new**

Do not open a public issue for a defect that can move money. Include:

- the version or commit,
- the smallest reproduction you have (a failing test is ideal),
- what an attacker gains: a double grant, a free call, a stolen challenge, a
  forged receipt, or a denial of settlement.

You will get an acknowledgement, an assessment, and a fix or a reasoned refusal.
Credit is given by work, in the advisory and the changelog, unless you ask
otherwise.

## In scope

- Settlement: amount, currency, status, grace window, ordering.
- The atomic claim and its release path.
- Challenge lifecycle: nonce entropy and charset, TTL, ownership, per-key cap.
- Receipts: canonical form, HMAC verification, version handling.
- Fail-closed behaviour when the store is unreachable.
- Anything that lets a caller obtain paid resources without a settled payment.

## Out of scope

- Fraud on the provider side (Wompi, PSE, Nequi) or a compromised provider
  account. c402 verifies what the provider reports; it cannot audit the bank.
- A deployment that sets `failClosed: false`, uses `MemoryStore` across
  processes, or replaces `SET ... NX` with a plain `SET`. Those are documented
  as non-conformant, not as vulnerabilities.
- Denial of service by volume. The per-key cap is an anti-flood mitigation, not
  a rate limiter; put one in front.

## What never enters this repository

Provider secrets, receipt secrets, API keys, real transaction ids, customer
data, or a LUKS/disk passphrase. Tests use synthetic values only. If you find a
secret in the tree or in history, report it privately and do not quote it in an
issue.
