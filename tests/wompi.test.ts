import { describe, expect, it } from 'vitest'
import {
  buildChallengeReference,
  buildCheckoutUrl,
  computeEventChecksum,
  isApprovedStatus,
  parseNonceFromReference,
  parseWompiEvent,
  verifyEventChecksum,
} from '../src/providers/wompi.js'

const SECRET = 'events-secret'
const BODY = JSON.stringify({
  event: { type: 'transaction.updated', timestamp: 1 },
  data: {
    transaction: {
      id: 'tx-1',
      status: 'APPROVED',
      reference: 'c402_n-1',
      amount_in_cents: 2500,
      currency: 'COP',
    },
  },
})

describe('wompi checksum', () => {
  it('accepts a correct checksum', () => {
    expect(verifyEventChecksum(BODY, computeEventChecksum(BODY, SECRET), SECRET)).toBe(true)
  })

  it('rejects a tampered body', () => {
    const good = computeEventChecksum(BODY, SECRET)
    expect(verifyEventChecksum(BODY.replace('2500', '1'), good, SECRET)).toBe(false)
  })

  it('rejects the wrong secret', () => {
    expect(verifyEventChecksum(BODY, computeEventChecksum(BODY, 'other'), SECRET)).toBe(false)
  })

  it('rejects missing, malformed and short checksums without throwing', () => {
    expect(verifyEventChecksum(BODY, null, SECRET)).toBe(false)
    expect(verifyEventChecksum(BODY, '', SECRET)).toBe(false)
    expect(verifyEventChecksum(BODY, 'zzzz', SECRET)).toBe(false)
    expect(verifyEventChecksum(BODY, 'abc', SECRET)).toBe(false)
    expect(verifyEventChecksum(BODY, computeEventChecksum(BODY, SECRET), '')).toBe(false)
  })
})

describe('wompi reference + event parsing', () => {
  it('round-trips a challenge reference', () => {
    expect(parseNonceFromReference(buildChallengeReference('abc'))).toBe('abc')
  })

  it('rejects non-c402 references', () => {
    expect(parseNonceFromReference('subscription_api_1')).toBeNull()
    expect(parseNonceFromReference('c402_')).toBeNull()
    expect(parseNonceFromReference(null)).toBeNull()
  })

  it('normalises a webhook payload', () => {
    const e = parseWompiEvent(JSON.parse(BODY))
    expect(e).toEqual({
      reference: 'c402_n-1',
      status: 'APPROVED',
      amountInCents: 2500,
      currency: 'COP',
      transactionId: 'tx-1',
    })
  })

  it('returns null for incomplete payloads', () => {
    expect(parseWompiEvent({})).toBeNull()
    expect(parseWompiEvent({ data: { transaction: { id: 'x' } } })).toBeNull()
    expect(
      parseWompiEvent({ data: { transaction: { id: 'x', reference: 'c402_n', amount_in_cents: 1.5 } } }),
    ).toBeNull()
  })

  it('identifies settleable statuses', () => {
    expect(isApprovedStatus('APPROVED')).toBe(true)
    expect(isApprovedStatus('COMPLETED')).toBe(true)
    expect(isApprovedStatus('DECLINED')).toBe(false)
    expect(isApprovedStatus(undefined)).toBe(false)
  })

  it('builds a checkout url with the amount in minor units', () => {
    const url = buildCheckoutUrl({
      publicKey: 'pub_test',
      amountCents: 2500,
      reference: 'c402_n-1',
      redirectUrl: 'https://example.com/developers',
    })
    expect(url).toContain('amount-in-cents=2500')
    expect(url).toContain('currency=COP')
    expect(url).toContain('reference=c402_n-1')
    expect(url.startsWith('https://checkout.wompi.co/p/?')).toBe(true)
  })
})
