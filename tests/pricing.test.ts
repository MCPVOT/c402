import { describe, expect, it } from 'vitest'
import { MIN_CALLS_FOR_CHALLENGE, PRICE_TIERS, calculatePrice } from '../src/pricing.js'

describe('price ladder', () => {
  it('returns the smallest covering tier', () => {
    expect(calculatePrice(1).calls).toBe(50)
    expect(calculatePrice(50).calls).toBe(50)
    expect(calculatePrice(51).calls).toBe(200)
    expect(calculatePrice(200).calls).toBe(200)
    expect(calculatePrice(201).calls).toBe(1000)
  })

  it('prices in minor units, not pesos', () => {
    expect(calculatePrice(50).amountCents).toBe(2500)
    expect(calculatePrice(200).amountCents).toBe(8000)
    expect(calculatePrice(1000).amountCents).toBe(30000)
  })

  it('falls back to the largest tier above the ladder', () => {
    expect(calculatePrice(99999).calls).toBe(PRICE_TIERS[PRICE_TIERS.length - 1]!.calls)
  })

  it('rejects invalid input', () => {
    expect(() => calculatePrice(0)).toThrow(RangeError)
    expect(() => calculatePrice(-5)).toThrow(RangeError)
  })

  it('satisfies the minimum challenge size', () => {
    expect(calculatePrice(MIN_CALLS_FOR_CHALLENGE).calls).toBe(50)
  })
})
