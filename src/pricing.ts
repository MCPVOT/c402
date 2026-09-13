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
 * Always returns the smallest tier that covers N.
 */
export function calculatePrice(extraCalls: number): Price {
  if (!Number.isFinite(extraCalls) || extraCalls < 1) {
    throw new RangeError('calculatePrice: extraCalls must be a positive number')
  }
  const tier = PRICE_TIERS.find((t) => extraCalls <= t.calls) ?? PRICE_TIERS[PRICE_TIERS.length - 1]!
  return { amountCents: copToCents(tier.priceCop), calls: tier.calls }
}
