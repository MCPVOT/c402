import { describe, expect, it } from 'vitest'
import { decideAccess } from '../src/gateway-decision.js'

describe('fail-closed access decisions', () => {
  it('allows the call when prepaid credits exist', () => {
    expect(decideAccess({ creditsRemaining: 3, storeAvailable: true, failClosed: true })).toEqual({
      action: 'allow',
      remainingCredits: 3,
    })
  })

  it('challenges with 402 when there are no credits and the store is healthy', () => {
    expect(decideAccess({ creditsRemaining: 0, storeAvailable: true, failClosed: true })).toEqual({
      action: 'pay',
      reason: 'no_credits',
    })
  })

  it('refuses the request when the store is down and failClosed is on', () => {
    expect(decideAccess({ creditsRemaining: 0, storeAvailable: false, failClosed: true })).toEqual({
      action: 'unavailable',
      reason: 'store_unavailable',
    })
  })

  it('documents the risky opt-out: serving free traffic during an outage', () => {
    const d = decideAccess({ creditsRemaining: 0, storeAvailable: false, failClosed: false })
    expect(d.action).toBe('pay')
  })
})
