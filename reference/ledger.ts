/**
 * Prepaid Credit Ledger — c402 Core
 *
 * Uses Upstash Redis via REST API for atomic balance operations.
 * Security: SHA-256 hashed API key IDs, atomic DECR, idempotency keys.
 *
 * NEVER expose raw Redis keys or tokens. All operations go through this module.
 */
import { createHash } from 'crypto'

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL || ''
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || ''

// Credit pack definitions (in COP)
export const CREDIT_PACKS = [
  { calls: 50, priceCOP: 2500, priceUSD: 0.60 },
  { calls: 200, priceCOP: 8000, priceUSD: 1.90 },
  { calls: 1000, priceCOP: 30000, priceUSD: 7.00 },
] as const

const CREDIT_TTL = 86400 * 365 // 1 year expiry for credits
const PREFIX = 'credits:'
const PURCHASE_PREFIX = 'credit_purchase:'

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

function hashedKey(apiKeyId: string): string {
  return createHash('sha256').update(PREFIX + apiKeyId).digest('hex')
}

/**
 * Get current prepaid credit balance for an API key
 * Returns 0 if no balance or Redis unavailable
 */
export async function getCreditBalance(apiKeyId: string): Promise<number> {
  const key = hashedKey(apiKeyId)
  const data = await redisFetch('GET', `get/${key}`)
  if (!data || data.result === null) return 0
  const val = parseInt(data.result, 10)
  return Number.isFinite(val) ? Math.max(0, val) : 0
}

/**
 * Atomically deduct one credit. Returns remaining balance, or -1 if insufficient.
 * Uses Redis DECR which is atomic — safe for concurrent requests.
 */
export async function deductCredit(apiKeyId: string): Promise<number> {
  const key = hashedKey(apiKeyId)
  // Use INCRBY -1 instead of DECR for consistency with other operations
  const data = await redisFetch('POST', `incrby/${key}/-1`)
  if (!data || data.result === null) return 0
  const remaining = parseInt(data.result, 10)
  if (remaining < 0) {
    // Overdrew — restore to 0 atomically, return -1 (prevents double-spend race)
    await redisFetch('POST', `incrby/${key}/1`, '')
  }
  // Always refresh TTL on any use (prevents orphan keys without expiry)
  await redisFetch('POST', `expire/${key}/${CREDIT_TTL}`, '')
  return remaining < 0 ? -1 : remaining
}

/**
 * Add credits to an API key's balance. Called after successful Wompi payment.
 * Uses INCRBY — atomic addition.
 */
export async function addCredits(apiKeyId: string, amount: number): Promise<number> {
  const key = hashedKey(apiKeyId)
  const data = await redisFetch('POST', `incrby/${key}/${amount}`)
  if (!data || data.result === null) return 0
  // Set expiry on first use
  await redisFetch('POST', `expire/${key}/${CREDIT_TTL}`, '')
  return parseInt(data.result, 10)
}

/**
 * Record a credit purchase in Redis (idempotency / audit trail)
 * Key: credit_purchase:{purchaseId} → JSON with details, TTL 7 days
 */
export async function recordPurchase(purchaseId: string, details: {
  apiKeyId: string
  calls: number
  amountCOP: number
  wompiTransactionId?: string
  paidAt?: string | null
}): Promise<boolean> {
  const key = PURCHASE_PREFIX + purchaseId
  const data = await redisFetch('POST', `set/${key}`, JSON.stringify(details))
  await redisFetch('POST', `expire/${key}/${86400 * 7}`, '')
  return !!data
}

/**
 * Check if a purchase was already recorded (idempotency)
 */
export async function getPurchase(purchaseId: string): Promise<any | null> {
  const data = await redisFetch('GET', `get/${PURCHASE_PREFIX + purchaseId}`)
  if (!data || data.result === null) return null
  try { return JSON.parse(data.result) } catch { return null }
}

/**
 * Check if we should allow a request using prepaid credits after rate limit exceeded.
 * Returns true if a credit was deducted (allow request), false if insufficient balance.
 * Only applies to FREE tier — higher tiers use their normal rate limit.
 */
export async function tryCreditFallback(apiKeyId: string, tier: string): Promise<boolean> {
  if (tier !== 'FREE') return false
  const balance = await getCreditBalance(apiKeyId)
  if (balance <= 0) return false
  const remaining = await deductCredit(apiKeyId)
  return remaining >= 0
}
