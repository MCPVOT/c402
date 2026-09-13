import { describe, expect, it } from 'vitest'
import { build402Body, buildChallengePayload, encodeChallengeHeader, parseChallengeHeader } from '../src/http.js'
import type { Challenge } from '../src/types.js'

const challenge: Challenge = {
  nonce: 'n-1',
  apiKeyId: 'key-1',
  amountCents: 2500,
  currency: 'COP',
  calls: 50,
  createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 600_000).toISOString(),
  paid: false,
}

describe('X-402-Challenge header', () => {
  it('round-trips a payload', () => {
    const payload = buildChallengePayload(challenge, 'https://checkout.wompi.co/p/?x=1')
    const parsed = parseChallengeHeader(encodeChallengeHeader(payload))
    expect(parsed).toEqual(payload)
    expect(parsed?.amountCents).toBe(2500)
  })

  it('rejects malformed headers', () => {
    expect(parseChallengeHeader(null)).toBeNull()
    expect(parseChallengeHeader('')).toBeNull()
    expect(parseChallengeHeader('not json')).toBeNull()
    expect(parseChallengeHeader('{"nonce":"n"}')).toBeNull()
    expect(parseChallengeHeader('{"nonce":"n","amountCents":"2500","currency":"COP"}')).toBeNull()
  })

  it('builds a 402 body', () => {
    const payload = buildChallengePayload(challenge, 'https://x')
    const body = build402Body(payload)
    expect(body.error).toBe('payment_required')
    expect(body.c402.nonce).toBe('n-1')
  })
})
