/**
 * c402 Subscription Billing — Redis Tier Management
 *
 * Provides Redis-backed storage for API access tier subscriptions.
 * When a user buys AGENTE or CONJUNTO tier, the tier and TTL are stored
 * in Redis. The rate limiter reads this to override the default FREE tier.
 *
 * Security:
 * - Only SHA-256 hashed API key IDs stored in Redis (no raw keys)
 * - TTL-based expiry ensures automatic downgrade to FREE
 * - Webhook SHA-256 verification protects writes
 */
import { createHash } from 'crypto'

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL || ''
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || ''

const TIER_PREFIX = 'api_tier:'
const PURCHASE_PREFIX = 'api_tier_purchase:'

const MONTH_SECONDS = 86400 * 30 // 30 days

export interface ApiTierInfo {
  tier: 'AGENTE' | 'CONJUNTO' | 'CONJUNTO_450' | 'CONSTRUCTORA'
  expiresAt: string
  autoRenew: boolean
  purchasedAt: string
}

export interface TierPurchase {
  apiKeyId: string
  tier: 'AGENTE' | 'CONJUNTO' | 'CONJUNTO_450' | 'CONSTRUCTORA'
  amountCOP: number
  paidAt: string | null
}

const TIER_PRICES: Record<string, number> = {
  AGENTE: 30000,
  CONJUNTO: 150000,
  CONJUNTO_450: 450000,
  CONSTRUCTORA: 999000,
}

export const API_TIERS = [
  { id: 'AGENTE', name: 'AGENTE API', priceCOP: 30000, reqPerDay: 1000, description: 'Para integradores y agentes' },
  { id: 'CONJUNTO', name: 'CONJUNTO API', priceCOP: 150000, reqPerDay: 5000, description: 'Para conjuntos y fintechs' },
  { id: 'CONJUNTO_450', name: 'CONJUNTO 450 API', priceCOP: 450000, reqPerDay: 25000, description: 'Para grandes conjuntos con DB dedicada' },
  { id: 'CONSTRUCTORA', name: 'CONSTRUCTORA API', priceCOP: 999000, reqPerDay: 100000, description: 'Para constructoras con MCP completo + DB aislada + Honcho dedicado' },
] as const

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

function hashedKey(apiKeyId: string, prefix: string): string {
  return createHash('sha256').update(prefix + apiKeyId).digest('hex')
}

/**
 * Get the active API tier for a given API key.
 * Returns null if no subscription or Redis unavailable.
 */
export async function getApiTier(apiKeyId: string): Promise<ApiTierInfo | null> {
  const key = hashedKey(apiKeyId, TIER_PREFIX)
  const data = await redisFetch('GET', `get/${key}`)
  if (!data || data.result === null) return null
  try {
    const tier: ApiTierInfo = JSON.parse(data.result)
    // Check expiry
    if (new Date(tier.expiresAt) < new Date()) {
      // Expired — clean up
      await redisFetch('POST', `del/${key}`, '')
      return null
    }
    return tier
  } catch { return null }
}

/**
 * Set or upgrade an API key's tier subscription.
 * TTL is 30 days from now. Overwrites any existing tier.
 */
export async function setApiTier(
  apiKeyId: string,
  tier: 'AGENTE' | 'CONJUNTO' | 'CONJUNTO_450' | 'CONSTRUCTORA',
  durationDays: number = 30,
): Promise<boolean> {
  const key = hashedKey(apiKeyId, TIER_PREFIX)
  const tierInfo: ApiTierInfo = {
    tier,
    expiresAt: new Date(Date.now() + durationDays * 86400 * 1000).toISOString(),
    autoRenew: false,
    purchasedAt: new Date().toISOString(),
  }
  const data = await redisFetch('POST', `set/${key}`, JSON.stringify(tierInfo))
  if (!data) return false
  await redisFetch('POST', `expire/${key}/${MONTH_SECONDS}`, '')
  return true
}

/**
 * Record a subscription purchase in Redis (idempotency / audit trail).
 * Key: api_tier_purchase:{purchaseId} → JSON, TTL 7 days.
 */
export async function recordPurchase(
  purchaseId: string,
  details: TierPurchase,
): Promise<boolean> {
  const key = PURCHASE_PREFIX + purchaseId
  const data = await redisFetch('POST', `set/${key}`, JSON.stringify(details))
  if (!data) return false
  await redisFetch('POST', `expire/${key}/${86400 * 7}`, '')
  return true
}

/**
 * Get a purchase record (for webhook idempotency).
 */
export async function getPurchase(purchaseId: string): Promise<TierPurchase | null> {
  const data = await redisFetch('GET', `get/${PURCHASE_PREFIX + purchaseId}`)
  if (!data || data.result === null) return null
  try { return JSON.parse(data.result) } catch { return null }
}

/**
 * Get the price for a given API tier.
 */
export function getTierPrice(tier: string): number {
  return TIER_PRICES[tier] || 0
}

/**
 * Check if a tier is valid.
 */
export function isValidTier(tier: string): tier is 'AGENTE' | 'CONJUNTO' | 'CONJUNTO_450' {
  return tier === 'AGENTE' || tier === 'CONJUNTO' || tier === 'CONJUNTO_450'
}
