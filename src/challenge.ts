import { randomUUID } from 'node:crypto'
import {
  DEFAULT_CONFIG,
  type C402Config,
  type Challenge,
  type ChallengeStore,
  type CreditLedger,
  type SettlementEvent,
  type SettleResult,
} from './types.js'
import { isValidAmountCents } from './money.js'
import { verifySettlement } from './settlement.js'
import { parseNonceFromReference } from './providers/wompi.js'

const OUTSTANDING_PREFIX = 'c402:outstanding:'

/** nonce -> epoch ms at which the challenge stops counting as outstanding. */
type OutstandingIndex = Record<string, number>

export class ChallengeLimitError extends Error {
  constructor(public readonly outstanding: number, public readonly limit: number) {
    super(`c402: too many unpaid challenges (${outstanding}/${limit})`)
    this.name = 'ChallengeLimitError'
  }
}

export interface CreateChallengeOptions {
  ttlSeconds?: number
  currency?: string
  maxOutstandingPerKey?: number
  now?: number
}

/**
 * Read the per-key outstanding index and drop entries that have expired.
 *
 * The index is timestamped rather than a bare counter because a counter can only
 * be decremented by settlement: every abandoned challenge would otherwise stay
 * counted after its TTL, and a caller could block itself out of new challenges.
 * A read failure degrades to an empty index on purpose - the cap is an
 * anti-flood mitigation and `put` fails closed anyway when the store is down.
 */
async function readLiveOutstanding(store: ChallengeStore, key: string, now: number): Promise<OutstandingIndex> {
  let index: OutstandingIndex = {}
  try {
    index = (await store.getJson<OutstandingIndex>(key)) ?? {}
  } catch {
    return {}
  }
  const live: OutstandingIndex = {}
  for (const [nonce, expiresAtMs] of Object.entries(index)) {
    if (typeof expiresAtMs === 'number' && Number.isFinite(expiresAtMs) && expiresAtMs > now) live[nonce] = expiresAtMs
  }
  return live
}

async function clearOutstanding(store: ChallengeStore, apiKeyId: string, nonce: string, ttlSeconds: number): Promise<void> {
  const key = OUTSTANDING_PREFIX + apiKeyId
  try {
    const index = (await store.getJson<OutstandingIndex>(key)) ?? {}
    if (!(nonce in index)) return
    delete index[nonce]
    await store.setJson(key, index, ttlSeconds)
  } catch {
    // Best effort: the expiry sweep in readLiveOutstanding() is the backstop.
  }
}

/**
 * Create a single-use payment challenge bound to an API key.
 *
 * Anti-flood: a per-key index caps how many unpaid challenges may exist at once,
 * so one caller cannot fill the store. Expired challenges are pruned on read,
 * so abandoning a challenge never blocks a later purchase.
 */
export async function createChallenge(
  store: ChallengeStore,
  apiKeyId: string,
  amountCents: number,
  calls: number,
  opts: CreateChallengeOptions = {},
): Promise<Challenge> {
  if (!isValidAmountCents(amountCents)) throw new RangeError('c402: amountCents must be a positive integer in minor units')
  if (!Number.isSafeInteger(calls) || calls <= 0) throw new RangeError('c402: calls must be a positive integer')

  const ttl = opts.ttlSeconds ?? DEFAULT_CONFIG.challengeTtlSeconds
  const currency = opts.currency ?? DEFAULT_CONFIG.currency
  const limit = opts.maxOutstandingPerKey ?? DEFAULT_CONFIG.maxOutstandingPerKey
  const now = opts.now ?? Date.now()

  const outstandingKey = OUTSTANDING_PREFIX + apiKeyId
  const index = await readLiveOutstanding(store, outstandingKey, now)
  if (Object.keys(index).length >= limit) {
    throw new ChallengeLimitError(Object.keys(index).length, limit)
  }

  const nonce = randomUUID()
  const expiresAtMs = now + ttl * 1000
  const challenge: Challenge = {
    nonce,
    apiKeyId,
    amountCents,
    currency,
    calls,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(expiresAtMs).toISOString(),
    paid: false,
  }

  await store.put(challenge, ttl)
  index[nonce] = expiresAtMs
  await store.setJson(outstandingKey, index, ttl * 2)
  return challenge
}

export async function getChallenge(store: ChallengeStore, nonce: string): Promise<Challenge | null> {
  return store.get(nonce)
}

export type RetryAuthorization = { ok: true } | { ok: false; reason: 'not_owner' | 'unpaid' | 'expired' }

export interface RetryOptions {
  /**
   * How long after `expiresAt` a settled challenge may still be redeemed.
   * Defaults to the configured redemption grace. Settlement accepts late
   * webhooks for `settlementGraceSeconds`; honouring the retry for less than
   * that would take the money and refuse the credits.
   */
  graceSeconds?: number
}

/**
 * Authorise a client retry that presents X-402-Payment-Id.
 * The challenge must belong to the caller, be settled, and be inside the
 * redemption window (TTL plus grace).
 */
export function authorizeRetry(
  challenge: Challenge,
  apiKeyId: string,
  now: number = Date.now(),
  opts: RetryOptions = {},
): RetryAuthorization {
  if (challenge.apiKeyId !== apiKeyId) return { ok: false, reason: 'not_owner' }
  if (!challenge.paid) return { ok: false, reason: 'unpaid' }
  const expiresAt = Date.parse(challenge.expiresAt)
  // Fail closed on an unparseable timestamp: NaN < now is false, which would
  // silently authorise a corrupted record.
  if (!Number.isFinite(expiresAt)) return { ok: false, reason: 'expired' }
  const grace = opts.graceSeconds ?? DEFAULT_CONFIG.redemptionGraceSeconds
  if (now > expiresAt + grace * 1000) return { ok: false, reason: 'expired' }
  return { ok: true }
}

export interface SettleParams {
  store: ChallengeStore
  ledger: CreditLedger
  event: SettlementEvent
  config?: Partial<C402Config>
}

/**
 * The authoritative settlement flow.
 *
 * Order matters and must not be reordered:
 *   1. resolve the challenge from the provider reference
 *   2. verify amount + currency + status against the stored challenge
 *   3. atomically claim the nonce (claimOnce) - the ONLY gate against double grants
 *   4. grant credits
 *   5. record the paid flag + transaction id for audit
 *
 * Failure handling is part of the contract:
 *   - store unreachable during lookup => `store_unavailable`, NOT
 *     `unknown_challenge`. The provider must retry; a 200 here would drop a
 *     payment for a challenge that does exist.
 *   - credit grant fails after the claim => the claim is released and
 *     `grant_failed` is returned, so the provider's retry can still grant.
 *     A burned claim would mean the buyer paid and never received credits.
 *   - audit patch fails after a successful grant => credits stand, the claim
 *     stays taken, and duplicate deliveries are answered idempotently.
 *
 * A lost claim (another delivery won the race) means the caller must answer
 * 200 idempotently rather than error.
 */
export async function settleAndGrant(params: SettleParams): Promise<SettleResult> {
  const { store, ledger, event } = params
  const cfg = { ...DEFAULT_CONFIG, ...(params.config ?? {}) }

  const nonce = parseNonceFromReference(event.reference)
  if (!nonce) return { ok: false, reason: 'unknown_challenge', challenge: null }

  let challenge: Challenge | null
  try {
    challenge = await store.get(nonce)
  } catch {
    return { ok: false, reason: 'store_unavailable', challenge: null }
  }

  if (!challenge) {
    // A miss is only trustworthy when the store itself is answering.
    if (store.available === false) return { ok: false, reason: 'store_unavailable', challenge: null }
    return { ok: false, reason: 'unknown_challenge', challenge: null }
  }
  if (challenge.paid) return { ok: false, reason: 'already_settled', challenge }

  const verified = verifySettlement(challenge, event, {
    graceSeconds: cfg.settlementGraceSeconds,
    allowedStatuses: ['APPROVED', 'COMPLETED'],
  })
  if (!verified.ok) return { ok: false, reason: verified.reason, challenge }

  let claimed: boolean
  try {
    claimed = await store.claimOnce(nonce, cfg.auditTtlSeconds)
  } catch {
    return { ok: false, reason: 'store_unavailable', challenge }
  }
  if (!claimed) return { ok: false, reason: 'claim_lost', challenge }

  let granted: number
  try {
    granted = await ledger.add(challenge.apiKeyId, challenge.calls)
  } catch {
    // Money already moved at the provider. Release the claim so a retry can
    // still grant, instead of losing the payment behind a permanent marker.
    try {
      await store.releaseClaim(nonce)
    } catch {
      // If even the release fails the claim expires with auditTtlSeconds and a
      // later delivery can settle; report the failure either way.
    }
    return { ok: false, reason: 'grant_failed', challenge }
  }

  try {
    await store.patch(
      nonce,
      { paid: true, settledTransactionId: event.transactionId },
      cfg.auditTtlSeconds,
    )
  } catch {
    // Credits are granted and the claim holds; the audit flag is best effort.
  }

  await clearOutstanding(store, challenge.apiKeyId, nonce, cfg.auditTtlSeconds)

  return { ok: true, granted, challenge }
}
