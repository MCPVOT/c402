import { describe, expect, it } from 'vitest'
import { verifySettlement } from '../src/settlement.js'
import type { Challenge } from '../src/types.js'

const NOW = Date.parse('2026-08-24T12:00:00.000Z')

function challenge(over: Partial<Challenge> = {}): Challenge {
  return {
    nonce: 'n-1',
    apiKeyId: 'key-1',
    amountCents: 2500,
    currency: 'COP',
    calls: 50,
    createdAt: new Date(NOW - 60_000).toISOString(),
    expiresAt: new Date(NOW + 600_000).toISOString(),
    paid: false,
    ...over,
  }
}

const event = (over: Partial<{ status: string; amountInCents: number; currency: string }> = {}) => ({
  reference: 'c402_n-1',
  status: 'APPROVED',
  amountInCents: 2500,
  currency: 'COP',
  transactionId: 'tx-1',
  ...over,
})

describe('verifySettlement', () => {
  it('accepts an exact match', () => {
    expect(verifySettlement(challenge(), event(), { now: NOW }).ok).toBe(true)
  })

  it('rejects an underpayment', () => {
    const r = verifySettlement(challenge(), event({ amountInCents: 1 }), { now: NOW })
    expect(r).toEqual({ ok: false, reason: 'amount_mismatch' })
  })

  it('rejects an overpayment', () => {
    const r = verifySettlement(challenge(), event({ amountInCents: 2501 }), { now: NOW })
    expect(r).toEqual({ ok: false, reason: 'amount_mismatch' })
  })

  it('rejects a non-integer amount', () => {
    const r = verifySettlement(challenge(), event({ amountInCents: 2500.5 }), { now: NOW })
    expect(r).toEqual({ ok: false, reason: 'amount_mismatch' })
  })

  it('rejects a currency mismatch', () => {
    const r = verifySettlement(challenge(), event({ currency: 'USD' }), { now: NOW })
    expect(r).toEqual({ ok: false, reason: 'currency_mismatch' })
  })

  it('compares currency case-insensitively', () => {
    expect(verifySettlement(challenge(), event({ currency: 'cop' }), { now: NOW }).ok).toBe(true)
  })

  it('rejects declined and voided statuses', () => {
    for (const status of ['DECLINED', 'VOIDED', 'ERROR', 'PENDING', '']) {
      expect(verifySettlement(challenge(), event({ status }), { now: NOW })).toEqual({
        ok: false,
        reason: 'invalid_status',
      })
    }
  })

  it('accepts COMPLETED as a settleable status', () => {
    expect(verifySettlement(challenge(), event({ status: 'COMPLETED' }), { now: NOW }).ok).toBe(true)
  })

  it('allows late webhooks inside the grace window', () => {
    const expired = challenge({ expiresAt: new Date(NOW - 3600_000).toISOString() })
    expect(verifySettlement(expired, event(), { now: NOW, graceSeconds: 86400 }).ok).toBe(true)
  })

  it('rejects webhooks past the grace window', () => {
    const expired = challenge({ expiresAt: new Date(NOW - 48 * 3600_000).toISOString() })
    expect(verifySettlement(expired, event(), { now: NOW, graceSeconds: 86400 })).toEqual({
      ok: false,
      reason: 'expired_beyond_grace',
    })
  })
})
