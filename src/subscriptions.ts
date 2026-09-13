import type { ChallengeStore } from './types.js'
import { copToCents } from './money.js'

/**
 * c402 P3: API tier subscriptions.
 * A tier purchase is settled through the same 402 flow; this module owns the
 * price ladder and the activation record.
 */
export const API_TIERS = {
  AGENTE: { priceCop: 49000, callsPerMonth: 5000 },
  CONJUNTO: { priceCop: 149000, callsPerMonth: 20000 },
  CONJUNTO_450: { priceCop: 249000, callsPerMonth: 50000 },
  CONSTRUCTORA: { priceCop: 499000, callsPerMonth: 150000 },
} as const

export type ApiTier = keyof typeof API_TIERS

const PURCHASE_PREFIX = 'c402:purchase:'
const TIER_PREFIX = 'c402:tier:'
const PURCHASE_TTL = 86400 * 7
const TIER_TTL = 86400 * 40

export interface TierPurchase {
  apiKeyId: string
  tier: ApiTier
  amountCents: number
  paidAt: string | null
}

export interface ActiveTier {
  tier: ApiTier
  activatedAt: string
  expiresAt: string
}

export function isValidTier(value: string): value is ApiTier {
  return Object.prototype.hasOwnProperty.call(API_TIERS, value)
}

/** Tier price in minor units (centavos). */
export function getTierPriceCents(tier: ApiTier): number {
  return copToCents(API_TIERS[tier].priceCop)
}

export async function recordPurchase(
  store: ChallengeStore,
  purchaseId: string,
  details: TierPurchase,
): Promise<void> {
  await store.setJson(PURCHASE_PREFIX + purchaseId, details, PURCHASE_TTL)
}

export async function getPurchase(store: ChallengeStore, purchaseId: string): Promise<TierPurchase | null> {
  return store.getJson<TierPurchase>(PURCHASE_PREFIX + purchaseId)
}

export async function activateTier(
  store: ChallengeStore,
  purchaseId: string,
  purchase: TierPurchase,
  days = 30,
  now: number = Date.now(),
): Promise<ActiveTier> {
  const active: ActiveTier = {
    tier: purchase.tier,
    activatedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + days * 86400 * 1000).toISOString(),
  }
  await store.setJson(TIER_PREFIX + purchase.apiKeyId, active, TIER_TTL)
  await recordPurchase(store, purchaseId, { ...purchase, paidAt: new Date(now).toISOString() })
  return active
}

export async function getActiveTier(store: ChallengeStore, apiKeyId: string): Promise<ActiveTier | null> {
  return store.getJson<ActiveTier>(TIER_PREFIX + apiKeyId)
}
