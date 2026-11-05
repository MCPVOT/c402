import { describe, expect, it } from 'vitest'
import {
  C402_PROTOCOL_VERSION,
  DISCOVERY_PATH,
  RAILS,
  buildDiscoveryDocument,
  describePaymentStatus,
} from '../src/discovery.js'
import type { Challenge } from '../src/types.js'

const T0 = Date.parse('2026-08-24T21:00:00.000Z')

const challenge = (over: Partial<Challenge> = {}): Challenge => ({
  nonce: 'b3f1c9e2-9a4d-4f61-8b3a-9f1e0d7c2a55',
  apiKeyId: 'k',
  amountCents: 250000,
  currency: 'COP',
  calls: 50,
  createdAt: new Date(T0).toISOString(),
  expiresAt: new Date(T0 + 1_800_000).toISOString(),
  paid: false,
  ...over,
})

describe('discovery document', () => {
  it('describes the protocol an agent needs to decide to pay', () => {
    const doc = buildDiscoveryDocument({ receipt: { supported: true } })
    expect(doc.protocol).toBe('c402')
    expect(doc.version).toBe(C402_PROTOCOL_VERSION)
    expect(doc.currency).toBe('COP')
    expect(doc.challenge.header).toBe('X-402-Challenge')
    expect(doc.challenge.ttlSeconds).toBe(1800)
    expect(doc.settlement.claim).toBe('SET NX')
    expect(doc.settlement.settleableStatuses).toEqual(['APPROVED', 'COMPLETED'])
    expect(doc.receipt).toEqual({
      supported: true,
      algorithm: 'HMAC-SHA256',
      version: 'c402-receipt-v1',
    })
    expect(doc.rails).toEqual([...RAILS])
    expect(doc.endpoints.discovery).toBe(DISCOVERY_PATH)
  })

  it('reports receipt support honestly when disabled', () => {
    const doc = buildDiscoveryDocument()
    expect(doc.receipt).toEqual({ supported: false, algorithm: null, version: null })
  })

  it('lets a deployment narrow its rails', () => {
    const doc = buildDiscoveryDocument({ rails: ['wompi', 'nequi'] })
    expect(doc.rails).toEqual(['wompi', 'nequi'])
  })

  it('is JSON serialisable', () => {
    expect(() => JSON.parse(JSON.stringify(buildDiscoveryDocument()))).not.toThrow()
  })
})

describe('describePaymentStatus', () => {
  it('reports pending before expiry', () => {
    const s = describePaymentStatus(challenge(), T0 + 1000)
    expect(s.status).toBe('pending')
    expect(s.amountCents).toBe(250000)
    expect(s.transactionId).toBeNull()
  })

  it('reports expired for an unpaid challenge past its TTL', () => {
    expect(describePaymentStatus(challenge(), T0 + 1_800_001).status).toBe('expired')
  })

  it('reports paid once settled, and exposes the transaction id', () => {
    const s = describePaymentStatus(
      challenge({ paid: true, settledTransactionId: 'tx-9' }),
      T0 + 1000,
    )
    expect(s.status).toBe('paid')
    expect(s.transactionId).toBe('tx-9')
  })

  it('keeps reporting paid after expiry: the money moved', () => {
    const s = describePaymentStatus(challenge({ paid: true }), T0 + 10 * 86400_000)
    expect(s.status).toBe('paid')
  })

  it('reports unknown for a missing challenge without leaking anything', () => {
    const s = describePaymentStatus(null, T0)
    expect(s.status).toBe('unknown')
    expect(s.nonce).toBeNull()
    expect(s.amountCents).toBeNull()
  })
})
