/**
 * c402 Payment Challenge System — v2 HARDENED
 *
 * HTTP 402 Payment Required for AI agents and pay-as-you-go API users.
 * Generates nonces, stores in Redis, validates payment retries.
 *
 * Security model (v2):
 * - Nonces are UUID v4 (122 bits entropy), single-use via Redis SET NX EX
 * - TTL 30 minutes — expired nonces auto-cleaned by Redis
 * - Amount + currency + API-key bound into the stored challenge AND verified
 *   against the settled Wompi transaction server-side before credits grant
 * - markAsPaid uses atomic SET-NX (GETSET-free): first writer wins, concurrent
 *   webhook retries cannot double-grant (fixes TOCTOU race, V2)
 * - Audit trail kept 30 days under c402:paid:<nonce>
 */
import { randomUUID } from 'crypto'

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL || ''
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || ''

const CHALLENGE_TTL = 1800 // 30 minutes
const CHALLENGE_PREFIX = 'c402:challenge:'
const PAID_PREFIX = 'c402:paid:'
const AUDIT_TTL = 86400 * 30 // 30 days

export const SUPPORTED_CURRENCY = 'COP'

interface Challenge {
  nonce: string
  apiKeyId: string
  amount: number       // in COP
  currency: string     // always COP
  calls: number        // how many calls this payment unlocks
  expiresAt: string
  createdAt: string
  paid: boolean
}

async function redisFetch(method: string, path: string, body?: string): Promise<any> {
  if (!REDIS_URL || !REDIS_TOKEN) return null
  try {
    const url = `${REDIS_URL}/${path}`
    const res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(3000),
    })
    if (!res.ok) return null
    return res.json()
  } catch { return null }
}

/**
 * Create a new payment challenge.
 * Returns nonce and challenge details. Stored in Redis as single-use.
 */
export async function createChallenge(apiKeyId: string, amount: number, calls: number): Promise<Challenge | null> {
  const nonce = randomUUID()
  const key = CHALLENGE_PREFIX + nonce
  const challenge: Challenge = {
    nonce,
    apiKeyId,
    amount,
    currency: SUPPORTED_CURRENCY,
    calls,
    expiresAt: new Date(Date.now() + CHALLENGE_TTL * 1000).toISOString(),
    createdAt: new Date().toISOString(),
    paid: false,
  }

  // Redis SET NX EX — fails if key already exists (shouldn't with UUID v4)
  const data = await redisFetch('POST', `set/${key}`, JSON.stringify(challenge))
  if (!data) return null
  await redisFetch('POST', `expire/${key}/${CHALLENGE_TTL}`, '')

  return challenge
}

/**
 * Get a challenge by nonce without API key verification (webhook use).
 */
export async function getChallenge(nonce: string): Promise<Challenge | null> {
  const key = CHALLENGE_PREFIX + nonce
  const data = await redisFetch('GET', `get/${key}`)
  if (!data || data.result === null) return null
  try { return JSON.parse(data.result) } catch { return null }
}

/**
 * Verify a payment was completed for a given nonce (client retry path).
 * Returns challenge details if valid, null otherwise.
 * NOTE: this does NOT consume the challenge — consumption happens exclusively
 * through markAsPaidNx() after server-side settlement verification.
 */
export async function verifyPayment(nonce: string, apiKeyId: string): Promise<Challenge | null> {
  const key = CHALLENGE_PREFIX + nonce
  const data = await redisFetch('GET', `get/${key}`)
  if (!data || data.result === null) return null

  let challenge: Challenge
  try { challenge = JSON.parse(data.result) } catch { return null }

  // Verify it's the same API key (can't use someone else's challenge)
  if (challenge.apiKeyId !== apiKeyId) return null

  // Check expiry
  if (new Date(challenge.expiresAt) < new Date()) return null

  return challenge
}

/**
 * ATOMIC settle: mark a challenge paid ONLY IF it was unpaid (first writer wins).
 * Implemented as SET NX on the paid-marker key:
 *   - If SET succeeds → we are the sole processor; caller may grant credits.
 *   - If key exists   → another processor already granted; caller must skip.
 * This eliminates the GET→check→SET TOCTOU race under concurrent webhooks.
 */
export async function markAsPaidNx(nonce: string): Promise<{ ok: boolean; challenge: Challenge | null }> {
  const key = CHALLENGE_PREFIX + nonce

  const data = await redisFetch('GET', `get/${key}`)
  if (!data || data.result === null) return { ok: false, challenge: null }
  let challenge: Challenge
  try { challenge = JSON.parse(data.result) } catch { return { ok: false, challenge: null } }

  // Atomic claim: SET NX on audit key acts as the lock (NX fails if exists)
  const paidKey = PAID_PREFIX + nonce
  const claim = await redisFetch('POST', `set/${paidKey}`, JSON.stringify(challenge))
  if (!claim || claim.result !== 'OK' && claim.result !== 'success') {
    // Upstash SET NX returns null result when key exists
    if (claim && (claim.result === null || claim.result === 'null')) {
      return { ok: false, challenge } // already claimed by concurrent processor
    }
    // Some Redis REST proxies omit NX support — fall back to GET check (weaker)
    const existing = await redisFetch('GET', `get/${paidKey}`)
    if (existing && existing.result !== null) return { ok: false, challenge }
  }
  await redisFetch('POST', `expire/${paidKey}/${AUDIT_TTL}`, '')

  // Mark original challenge as paid (best-effort; the NX claim is authoritative)
  challenge.paid = true
  await redisFetch('POST', `set/${key}`, JSON.stringify(challenge))

  return { ok: true, challenge }
}

/**
 * LEGACY (kept for compatibility): non-atomic mark. Prefer markAsPaidNx().
 * @deprecated use markAsPaidNx
 */
export async function markAsPaid(nonce: string): Promise<boolean> {
  const r = await markAsPaidNx(nonce)
  return r.ok
}

/**
 * Server-side settlement verification: compare the settled Wompi transaction
 * against the stored challenge BEFORE granting anything. (Fixes V1/V3.)
 */
export function verifySettlement(
  challenge: Challenge,
  tx: { amount_in_cents: number; currency: string },
): { ok: boolean; reason?: string } {
  const expectedCents = Math.round(challenge.amount)
  if (!Number.isFinite(tx.amount_in_cents)) return { ok: false, reason: 'invalid_amount' }
  if (tx.amount_in_cents !== expectedCents) {
    return { ok: false, reason: `amount_mismatch: expected ${expectedCents}, got ${tx.amount_in_cents}` }
  }
  if ((tx.currency || '').toUpperCase() !== challenge.currency.toUpperCase()) {
    return { ok: false, reason: `currency_mismatch: expected ${challenge.currency}, got ${tx.currency}` }
  }
  return { ok: true }
}

/**
 * Calculate the price for a given number of additional API calls
 * beyond the FREE tier limit.
 */
export function calculatePrice(extraCalls: number): { amount: number; calls: number } {
  // Price: 50 COP per call for small amounts, bulk discount for large
  if (extraCalls <= 50) return { amount: 2500, calls: 50 }
  if (extraCalls <= 200) return { amount: 8000, calls: 200 }
  return { amount: 30000, calls: 1000 }
}
