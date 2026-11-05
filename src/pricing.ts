import { copToCents } from './money.js'

export interface PriceTier {
  /** Inclusive lower bound of requested extra calls. */
  minCalls: number
  /** Price in COP pesos (converted to minor units on lookup). */
  priceCop: number
  /** Calls unlocked by this tier. */
  calls: number
}

/** Published c402 price ladder (COP). Keep in sync with SPEC.md section 4. */
export const PRICE_TIERS: readonly PriceTier[] = [
  { minCalls: 1, priceCop: 25, calls: 50 },
  { minCalls: 51, priceCop: 80, calls: 200 },
  { minCalls: 201, priceCop: 300, calls: 1000 },
] as const

/** Minimum calls a 402 challenge may ask for, to avoid dust payments. */
export const MIN_CALLS_FOR_CHALLENGE = 50

export interface Price {
  amountCents: number
  calls: number
}

/**
 * Resolve the price for N additional calls.
 *
 * The winner is the LAST tier whose `minCalls` the request reaches. Selection is
 * by `minCalls` rather than by `calls` so the table is the single source of
 * truth: editing `calls` alone can no longer make two selectors disagree.
 */
export function calculatePrice(extraCalls: number): Price {
  if (!Number.isFinite(extraCalls) || extraCalls < 1) {
    throw new RangeError('calculatePrice: extraCalls must be a positive number')
  }
  let chosen = PRICE_TIERS[0]!
  for (const tier of PRICE_TIERS) {
    if (extraCalls >= tier.minCalls) chosen = tier
  }
  return { amountCents: copToCents(chosen.priceCop), calls: chosen.calls }
}

/** Validates the ladder itself: contiguous from 1, positive, calls >= minCalls. */
export function assertPriceLadder(tiers: readonly PriceTier[] = PRICE_TIERS): void {
  if (tiers.length === 0) throw new Error('price ladder is empty')
  let expectedMin = 1
  for (const tier of tiers) {
    if (tier.minCalls !== expectedMin) {
      throw new Error(`price ladder gap: expected minCalls=${expectedMin}, got ${tier.minCalls}`)
    }
    if (!Number.isSafeInteger(tier.priceCop) || tier.priceCop <= 0) {
      throw new Error(`price ladder: priceCop must be a positive integer at minCalls=${tier.minCalls}`)
    }
    if (!Number.isSafeInteger(tier.calls) || tier.calls < tier.minCalls) {
      throw new Error(`price ladder: calls must be >= minCalls at minCalls=${tier.minCalls}`)
    }
    expectedMin = tier.calls + 1
  }
}
