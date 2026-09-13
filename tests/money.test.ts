import { describe, expect, it } from 'vitest'
import { centsToCop, copToCents, formatCents, isValidAmountCents } from '../src/money.js'

describe('money units (COP has 2 decimals)', () => {
  it('converts pesos to minor units', () => {
    expect(copToCents(25)).toBe(2500)
    expect(copToCents(2500)).toBe(250000)
    expect(copToCents(0.5)).toBe(50)
  })

  it('round-trips', () => {
    expect(centsToCop(copToCents(1234.56))).toBeCloseTo(1234.56, 2)
  })

  it('rejects non-numbers', () => {
    expect(() => copToCents(Number.NaN)).toThrow(TypeError)
    expect(() => copToCents(Infinity)).toThrow(TypeError)
  })

  it('validates minor-unit amounts', () => {
    expect(isValidAmountCents(2500)).toBe(true)
    expect(isValidAmountCents(0)).toBe(false)
    expect(isValidAmountCents(-1)).toBe(false)
    expect(isValidAmountCents(1.5)).toBe(false)
    expect(isValidAmountCents('2500')).toBe(false)
    expect(isValidAmountCents(undefined)).toBe(false)
  })

  it('formats for display', () => {
    expect(formatCents(250000)).toBe('COP 2,500.00')
  })
})
