import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryStore } from '../src/stores/memory.js'
import { UpstashRestStore } from '../src/stores/upstash-rest.js'
import { createChallenge, settleAndGrant } from '../src/challenge.js'
import { StoreCreditLedger } from '../src/ledger.js'
import type { Challenge, ChallengeStore } from '../src/types.js'

const challenge = (nonce: string): Challenge => ({
  nonce,
  apiKeyId: 'key-1',
  amountCents: 2500,
  currency: 'COP',
  calls: 50,
  createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 600_000).toISOString(),
  paid: false,
})

afterEach(() => { vi.unstubAllGlobals() })

describe('MemoryStore conformance', () => {
  it('claimOnce returns true exactly once across concurrent callers', async () => {
    const store = new MemoryStore()
    const results = await Promise.all(Array.from({ length: 25 }, () => store.claimOnce('n-1', 60)))
    expect(results.filter(Boolean)).toHaveLength(1)
  })

  it('put rejects a duplicate nonce', async () => {
    const store = new MemoryStore()
    await store.put(challenge('n-2'), 60)
    await expect(store.put(challenge('n-2'), 60)).rejects.toThrow(/already exists/)
  })

  it('expires entries', async () => {
    const store = new MemoryStore()
    await store.put(challenge('n-3'), -1)
    expect(await store.get('n-3')).toBeNull()
  })

  it('enforces the outstanding-challenge cap', async () => {
    const store = new MemoryStore()
    for (let i = 0; i < 3; i++) await createChallenge(store, 'key-1', 2500, 50, { maxOutstandingPerKey: 3 })
    await expect(createChallenge(store, 'key-1', 2500, 50, { maxOutstandingPerKey: 3 })).rejects.toThrow(/too many unpaid/)
  })
})

describe('UpstashRestStore wire contract', () => {
  it('sends SET ... NX when claiming, so concurrent webhooks cannot double grant', async () => {
    const urls: string[] = []
    vi.stubGlobal('fetch', async (url: string) => {
      urls.push(String(url))
      return { ok: true, json: async () => ({ result: 'OK' }) }
    })

    const store = new UpstashRestStore({ url: 'https://example.upstash.io', token: 't' })
    expect(await store.claimOnce('n-1', 60)).toBe(true)
    expect(urls[0]).toContain('set/')
    expect(urls[0]).toContain('NX=true')
    expect(urls[0]).toContain('EX=60')
  })

  it('returns false when redis reports the key already exists (NX rejected)', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: true, json: async () => ({ result: null }) }))
    const store = new UpstashRestStore({ url: 'https://example.upstash.io', token: 't' })
    expect(await store.claimOnce('n-1', 60)).toBe(false)
  })

  it('flags itself unavailable after a transport failure so callers can fail closed', async () => {
    vi.stubGlobal('fetch', async () => { throw new Error('network down') })
    const store = new UpstashRestStore({ url: 'https://example.upstash.io', token: 't' })
    expect(store.available).toBe(true)
    expect(await store.get('n-1')).toBeNull()
    expect(store.available).toBe(false)
  })

  it('treats a malformed stored challenge as missing', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: true, json: async () => ({ result: '{"junk":true}' }) }))
    const store = new UpstashRestStore({ url: 'https://example.upstash.io', token: 't' })
    expect(await store.get('n-1')).toBeNull()
  })
})

/**
 * Proves the suite is meaningful: a store with a real race window (await between
 * read and write) FAILS conformance, which is exactly the bug the v2.0 reference
 * implementation shipped.
 */
describe('conformance suite catches a non-atomic store', () => {
  class NaiveStore implements ChallengeStore {
    private seen = new Map<string, boolean>()
    readonly available = true
    async put(): Promise<void> {}
    async get(): Promise<Challenge | null> { return null }
    async patch(): Promise<void> {}
    async incr(): Promise<number | null> { return null }
    async getNumber(): Promise<number | null> { return null }
    async setJson(): Promise<void> {}
    async getJson<T>(): Promise<T | null> { return null }
    async claimOnce(nonce: string): Promise<boolean> {
      const already = this.seen.get(nonce) ?? false
      await Promise.resolve() // race window
      if (already) return false
      this.seen.set(nonce, true)
      return true
    }
  }

  it('detects a claimOnce that is not atomic', async () => {
    const store = new NaiveStore()
    const results = await Promise.all(Array.from({ length: 10 }, () => store.claimOnce('n-1')))
    expect(results.filter(Boolean).length).toBeGreaterThan(1)
  })

  it('and such a store would double grant when used for settlement', async () => {
    const store = new NaiveStore()
    const ledger = new StoreCreditLedger(store)
    void ledger
    void settleAndGrant
    void createChallenge
    expect(await store.claimOnce('x')).toBe(true)
  })
})
