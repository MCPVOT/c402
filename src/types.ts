/**
 * c402 core types - framework agnostic.
 *
 * MONEY UNIT RULE (normative):
 * All amounts in c402 are integer MINOR UNITS (centavos) for COP.
 * `amountCents` is never a peso value. COP 2,500 = 250000 minor units.
 * Use money.ts helpers to convert. Never mix the two representations.
 */

export interface C402Config {
  /** How long a challenge stays valid before payment must arrive. Default 1800 (30 min). */
  challengeTtlSeconds: number
  /** How long settled challenges stay readable for audit/idempotency. Default 30 days. */
  auditTtlSeconds: number
  /** Settlement currency. c402 v2 supports COP only. */
  currency: string
  /** Late-arriving webhooks may settle this long after expiry. Default 86400 (24h). */
  settlementGraceSeconds: number
  /**
   * How long a client may still redeem a settled challenge after it expires.
   * MUST be >= settlementGraceSeconds, otherwise a webhook can grant credits
   * for a challenge the retry path already refuses to honour. Default 86400.
   */
  redemptionGraceSeconds: number
  /** Max simultaneous unpaid challenges per API key (anti-flood). Default 20. */
  maxOutstandingPerKey: number
  /**
   * Behaviour when the challenge store is unreachable.
   * c402 requires TRUE (fail closed). Set false only if you accept the risk.
   */
  failClosed: boolean
}

export const DEFAULT_CONFIG: C402Config = {
  challengeTtlSeconds: 1800,
  auditTtlSeconds: 86400 * 30,
  currency: 'COP',
  settlementGraceSeconds: 86400,
  redemptionGraceSeconds: 86400,
  maxOutstandingPerKey: 20,
  failClosed: true,
}

export interface Challenge {
  nonce: string
  apiKeyId: string
  /** Integer minor units (centavos). See MONEY UNIT RULE above. */
  amountCents: number
  currency: string
  /** How many API calls this payment unlocks. */
  calls: number
  createdAt: string
  expiresAt: string
  paid: boolean
  /** Provider transaction id once settled (audit). */
  settledTransactionId?: string
}

/** Raw provider payment event, normalised across providers. */
export interface SettlementEvent {
  reference: string
  status: string
  amountInCents: number
  currency: string
  transactionId: string
}

/**
 * Storage contract. Implementations MUST satisfy the atomicity requirements in
 * CONFORMANCE.md - the conformance suite in tests/stores.test.ts proves it.
 */
export interface ChallengeStore {
  /** Persist a new challenge. Must not overwrite an existing nonce. */
  put(challenge: Challenge, ttlSeconds: number): Promise<void>
  get(nonce: string): Promise<Challenge | null>
  /**
   * Atomically claim a nonce for settlement.
   * MUST return true exactly once for N concurrent calls (SET NX semantics).
   * Returns false for every later caller.
   */
  claimOnce(nonce: string, ttlSeconds: number): Promise<boolean>
  /**
   * Release a claim that was taken but could not be turned into a grant.
   * c402 requires this: money already moved at the provider, so a burned claim
   * would lose the payment permanently. Must be idempotent.
   */
  releaseClaim(nonce: string): Promise<void>
  /**
   * Best-effort read-modify-write for non-authoritative fields (paid flag,
   * settled transaction id). Never use this to decide whether to grant credits:
   * claimOnce() is the sole authority for settlement.
   */
  patch(nonce: string, fields: Partial<Challenge>, ttlSeconds: number): Promise<void>
  /** Increment a counter with TTL. Returns new value, or null if store unavailable. */
  incr(key: string, by: number, ttlSeconds: number): Promise<number | null>
  getNumber(key: string): Promise<number | null>
  /** Generic JSON key/value, used by protocol extensions (subscriptions, receipts). */
  setJson(key: string, value: unknown, ttlSeconds: number): Promise<void>
  getJson<T>(key: string): Promise<T | null>
  /** Best-effort observability hook. */
  readonly available?: boolean
}

export interface CreditLedger {
  add(apiKeyId: string, credits: number): Promise<number>
  balance(apiKeyId: string): Promise<number>
  /** Atomic deduct. Returns remaining balance, or -1 when insufficient. */
  deduct(apiKeyId: string): Promise<number>
}

export type SettleResult =
  | { ok: true; granted: number; challenge: Challenge }
  | { ok: false; reason: SettleReason; challenge: Challenge | null }

export type SettleReason =
  | 'store_unavailable'
  | 'unknown_challenge'
  | 'already_settled'
  | 'amount_mismatch'
  | 'currency_mismatch'
  | 'invalid_status'
  | 'invalid_challenge'
  | 'expired_beyond_grace'
  | 'claim_lost'
  | 'grant_failed'
