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
 * Create a single-use payment challenge bound to an API key.
 *
 * Anti-flood: a per-key outstanding counter caps how many unpaid challenges may
 * exist at once, so an unauthenticated-ish caller cannot fill the store.
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
  const outstanding = (await store.getNumber(outstandingKey)) ?? 0
  if (outstanding >= limit) throw new ChallengeLimitError(outstanding, limit)

  const nonce = randomUUID()
  const challenge: Challenge = {
    nonce,
    apiKeyId,
    amountCents,
    currency,
    calls,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttl * 1000).toISOString(),
    paid: false,
  }

  await store.put(challenge, ttl)
  await store.incr(outstandingKey, 1, ttl * 2)
  return challenge
}

export async function getChallenge(store: ChallengeStore, nonce: string): Promise<Challenge | null> {
  return store.get(nonce)
}

export type RetryAuthorization = { ok: true } | { ok: false; reason: 'not_owner' | 'unpaid' | 'expired' }

/**
 * Authorise a client retry that presents X-402-Payment-Id.
 * The challenge must belong to the caller, be settled, and be inside its TTL.
 */
export function authorizeRetry(challenge: Challenge, apiKeyId: string, now: number = Date.now()): RetryAuthorization {
  if (challenge.apiKeyId !== apiKeyId) return { ok: false, reason: 'not_owner' }
  if (!challenge.paid) return { ok: false, reason: 'unpaid' }
  if (Date.parse(challenge.expiresAt) < now) return { ok: false, reason: 'expired' }
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
 * A failure at step 3 means another concurrent webhook already granted; the
 * caller must answer 200 idempotently rather than error.
 */
export async function settleAndGrant(params: SettleParams): Promise<SettleResult> {
  const { store, ledger, event } = params
  const cfg = { ...DEFAULT_CONFIG, ...(params.config ?? {}) }

  const nonce = parseNonceFromReference(event.reference)
  if (!nonce) return { ok: false, reason: 'unknown_challenge', challenge: null }

  const challenge = await store.get(nonce)
  if (!challenge) return { ok: false, reason: 'unknown_challenge', challenge: null }
  if (challenge.paid) return { ok: false, reason: 'already_settled', challenge }

  const verified = verifySettlement(challenge, event, {
    graceSeconds: cfg.settlementGraceSeconds,
    allowedStatuses: ['APPROVED', 'COMPLETED'],
  })
  if (!verified.ok) return { ok: false, reason: verified.reason, challenge }

  const claimed = await store.claimOnce(nonce, cfg.auditTtlSeconds)
  if (!claimed) return { ok: false, reason: 'claim_lost', challenge }

  const granted = await ledger.add(challenge.apiKeyId, challenge.calls)

  await store.patch(
    nonce,
    { paid: true, settledTransactionId: event.transactionId },
    cfg.auditTtlSeconds,
  )
  await store.incr(OUTSTANDING_PREFIX + challenge.apiKeyId, -1, cfg.auditTtlSeconds)

  return { ok: true, granted, challenge }
}
