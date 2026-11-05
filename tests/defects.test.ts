import { afterEach, describe, expect, it, vi } from 'vitest'
import { authorizeRetry, createChallenge, settleAndGrant } from '../src/challenge.js'
import { StoreCreditLedger } from '../src/ledger.js'
import { MemoryStore } from '../src/stores/memory.js'
import { UpstashRestStore } from '../src/stores/upstash-rest.js'
import { verifySettlement } from '../src/settlement.js'
import { parseNonceFromReference } from '../src/providers/wompi.js'
import type { Challenge, ChallengeStore, CreditLedger, SettlementEvent } from '../src/types.js'

const T0 = Date.parse('2026-08-24T12:00:00.000Z')

/** Minimal store whose availability and lookups are scripted, for outage tests. */
class AutoStore implements ChallengeStore {
  available = true
  constructor(private readonly inner: MemoryStore = new MemoryStore()) {}
  put(c: Challenge, ttl: number) { return this.inner.put(c, ttl) }
  get(nonce: string) { return this.inner.get(nonce) }
  patch(nonce: string, f: Partial<Challenge>, ttl: number) { return this.inner.patch(nonce, f, ttl) }
  claimOnce(nonce: string, ttl: number) { return this.inner.claimOnce(nonce, ttl) }
  releaseClaim(nonce: string) { return this.inner.releaseClaim(nonce) }
  incr(k: string, by: number, ttl: number) { return this.inner.incr(k, by, ttl) }
  getNumber(k: string) { return this.inner.getNumber(k) }
  setJson(k: string, v: unknown, ttl: number) { return this.inner.setJson(k, v, ttl) }
  getJson<T>(k: string) { return this.inner.getJson<T>(k) }
}

const goodLedger = (): CreditLedger => {
  const balances = new Map<string, number>()
  return {
    async add(k, n) { const v = (balances.get(k) ?? 0) + n; balances.set(k, v); return v },
    async balance(k) { return balances.get(k) ?? 0 },
    async deduct(k) { const v = (balances.get(k) ?? 0) - 1; balances.set(k, v); return v < 0 ? -1 : v },
  }
}

const eventFor = (nonce: string, over: Partial<SettlementEvent> = {}): SettlementEvent => ({
  reference: `c402_${nonce}`,
  status: 'APPROVED',
  amountInCents: 2500,
  currency: 'COP',
  transactionId: 'tx-1',
  ...over,
})

afterEach(() => { vi.unstubAllGlobals() })

describe('regression: abandoned challenges must not lock a key out', () => {
  it('expired challenges stop counting toward the per-key cap', async () => {
    const store = new MemoryStore()
    for (let i = 0; i < 3; i++) {
      await createChallenge(store, 'k', 2500, 50, { maxOutstandingPerKey: 3, ttlSeconds: 1, now: T0 })
    }
    // same instant: the cap is real
    await expect(
      createChallenge(store, 'k', 2500, 50, { maxOutstandingPerKey: 3, ttlSeconds: 1, now: T0 }),
    ).rejects.toThrow(/too many unpaid/)

    // after the TTL, all three have expired and the caller can buy again
    const fresh = await createChallenge(store, 'k', 2500, 50, {
      maxOutstandingPerKey: 3, ttlSeconds: 1, now: T0 + 2_000,
    })
    expect(fresh.paid).toBe(false)
  })

  it('settling a challenge frees its slot immediately', async () => {
    const store = new MemoryStore()
    const ledger = goodLedger()
    const now = Date.now()
    const first = await createChallenge(store, 'k', 2500, 50, { maxOutstandingPerKey: 2, now })
    await createChallenge(store, 'k', 2500, 50, { maxOutstandingPerKey: 2, now })
    await expect(
      createChallenge(store, 'k', 2500, 50, { maxOutstandingPerKey: 2, now }),
    ).rejects.toThrow(/too many unpaid/)

    const res = await settleAndGrant({ store, ledger, event: eventFor(first.nonce) })
    expect(res.ok).toBe(true)

    const next = await createChallenge(store, 'k', 2500, 50, { maxOutstandingPerKey: 2, now })
    expect(next.nonce).not.toBe(first.nonce)
  })
})

describe('regression: a store outage is not an unknown challenge', () => {
  it('reports store_unavailable so the provider retries instead of dropping the payment', async () => {
    const store = new AutoStore()
    const c = await createChallenge(store, 'k', 2500, 50)
    store.available = false
    store.get = async () => null

    const res = await settleAndGrant({ store, ledger: goodLedger(), event: eventFor(c.nonce) })
    expect(res).toEqual({ ok: false, reason: 'store_unavailable', challenge: null })
  })

  it('reports store_unavailable when the claim itself throws', async () => {
    const store = new AutoStore()
    const c = await createChallenge(store, 'k', 2500, 50)
    store.claimOnce = async () => { throw new Error('redis down') }

    const res = await settleAndGrant({ store, ledger: goodLedger(), event: eventFor(c.nonce) })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe('store_unavailable')
  })

  it('a healthy store still reports unknown_challenge for a real miss', async () => {
    const store = new AutoStore()
    const res = await settleAndGrant({ store, ledger: goodLedger(), event: eventFor('a'.repeat(36)) })
    expect(res).toEqual({ ok: false, reason: 'unknown_challenge', challenge: null })
  })
})

describe('regression: a failed grant must not burn the nonce', () => {
  it('releases the claim so a retry still grants the paid credits', async () => {
    const store = new MemoryStore()
    const c = await createChallenge(store, 'k', 2500, 50)
    const event = eventFor(c.nonce)

    const broken: CreditLedger = {
      add: async () => { throw new Error('ledger down') },
      balance: async () => 0,
      deduct: async () => -1,
    }

    const first = await settleAndGrant({ store, ledger: broken, event })
    expect(first.ok).toBe(false)
    if (!first.ok) expect(first.reason).toBe('grant_failed')

    // the claim was released, so the provider's retry succeeds
    const ledger = goodLedger()
    const retry = await settleAndGrant({ store, ledger, event })
    expect(retry.ok).toBe(true)
    if (retry.ok) expect(retry.granted).toBe(50)
    expect(await ledger.balance('k')).toBe(50)
  })

  it('does not release the claim when the grant succeeded', async () => {
    const store = new MemoryStore()
    const c = await createChallenge(store, 'k', 2500, 50)
    await settleAndGrant({ store, ledger: goodLedger(), event: eventFor(c.nonce) })
    // claim still held: a replay is refused, not re-granted
    const replay = await settleAndGrant({ store, ledger: goodLedger(), event: eventFor(c.nonce) })
    expect(replay.ok).toBe(false)
    if (!replay.ok) expect(['already_settled', 'claim_lost']).toContain(replay.reason)
  })
})

describe('regression: retry window must cover the settlement grace', () => {
  const paid = (over: Partial<Challenge> = {}): Challenge => ({
    nonce: 'n-'.padEnd(36, 'x'),
    apiKeyId: 'k',
    amountCents: 2500,
    currency: 'COP',
    calls: 50,
    createdAt: new Date(T0).toISOString(),
    expiresAt: new Date(T0 + 60_000).toISOString(),
    paid: true,
    ...over,
  })

  it('honours a retry after the TTL but inside the redemption grace', () => {
    const later = T0 + 60_000 + 3600_000 // TTL plus one hour
    expect(authorizeRetry(paid(), 'k', later).ok).toBe(true)
  })

  it('refuses a retry past the redemption grace', () => {
    const wayLater = T0 + 60_000 + 2 * 86400_000
    expect(authorizeRetry(paid(), 'k', wayLater)).toEqual({ ok: false, reason: 'expired' })
  })

  it('refuses a malformed expiresAt instead of accepting NaN', () => {
    expect(authorizeRetry(paid({ expiresAt: 'not-a-date' }), 'k', T0)).toEqual({ ok: false, reason: 'expired' })
  })

  it('settlement refuses a challenge with a malformed expiresAt', () => {
    const bad = paid({ paid: false, expiresAt: 'not-a-date' })
    expect(verifySettlement(bad, eventFor(bad.nonce), { now: T0 })).toEqual({
      ok: false,
      reason: 'invalid_challenge',
    })
  })
})

describe('regression: reference parsing is a closed set', () => {
  it('rejects nonces that are not store-key safe', () => {
    expect(parseNonceFromReference('c402_../../etc/passwd')).toBeNull()
    expect(parseNonceFromReference('c402_has space')).toBeNull()
    expect(parseNonceFromReference('c402_short')).toBeNull()
    expect(parseNonceFromReference('c402_' + 'a'.repeat(200))).toBeNull()
  })

  it('accepts a UUID v4 nonce', () => {
    const nonce = 'b3f1c9e2-9a4d-4f61-8b3a-9f1e0d7c2a55'
    expect(parseNonceFromReference(`c402_${nonce}`)).toBe(nonce)
  })
})

describe('store releaseClaim wire contract', () => {
  it('sends DEL for the claim key', async () => {
    const urls: string[] = []
    vi.stubGlobal('fetch', async (url: string) => {
      urls.push(String(url))
      return { ok: true, json: async () => ({ result: 0 }) }
    })
    const store = new UpstashRestStore({ url: 'https://example.upstash.io', token: 't' })
    await store.releaseClaim('n-1')
    expect(urls[0]).toContain('del/')
    expect(urls[0]).toContain('c402%3Apaid%3An-1')
  })
})

describe('ledger concurrency', () => {
  it('never leaves a negative balance under concurrent deducts', async () => {
    const store = new MemoryStore()
    const ledger = new StoreCreditLedger(store)
    await ledger.add('k', 1)
    const results = await Promise.all(Array.from({ length: 8 }, () => ledger.deduct('k')))
    expect(results.filter((r) => r >= 0)).toHaveLength(1)
    expect(await ledger.balance('k')).toBe(0)
  })
})
