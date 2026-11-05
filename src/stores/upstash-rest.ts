import type { Challenge, ChallengeStore } from '../types.js'

export interface UpstashRestOptions {
  url: string
  token: string
  /** Request timeout in ms. Default 3000. */
  timeoutMs?: number
}

/**
 * Upstash Redis REST store.
 *
 * IMPORTANT: claimOnce() sends a real `SET key value EX ttl NX`. A plain SET
 * always returns OK and would silently break c402's double-grant protection.
 * tests/stores.test.ts asserts NX is present on the wire.
 */
export class UpstashRestStore implements ChallengeStore {
  private readonly url: string
  private readonly token: string
  private readonly timeoutMs: number
  /** Flipped false after a transport failure, so callers can fail closed. */
  private healthy = true

  constructor(opts: UpstashRestOptions) {
    this.url = opts.url.replace(/\/$/, '')
    this.token = opts.token
    this.timeoutMs = opts.timeoutMs ?? 3000
  }

  get available(): boolean { return this.healthy }

  private async call(path: string, init?: RequestInit): Promise<unknown | null> {
    try {
      const res = await fetch(`${this.url}/${path}`, {
        ...init,
        headers: { Authorization: `Bearer ${this.token}`, ...(init?.headers ?? {}) },
        signal: AbortSignal.timeout(this.timeoutMs),
      })
      this.healthy = res.ok
      if (!res.ok) return null
      const body = (await res.json()) as { result?: unknown }
      return body?.result ?? null
    } catch {
      this.healthy = false
      return null
    }
  }

  async put(challenge: Challenge, ttlSeconds: number): Promise<void> {
    const key = encodeURIComponent(`c402:challenge:${challenge.nonce}`)
    const value = encodeURIComponent(JSON.stringify(challenge))
    const res = await this.call(`set/${key}/${value}?EX=${ttlSeconds}&NX=true`)
    if (res !== 'OK') throw new Error('c402: challenge nonce already exists')
  }

  async get(nonce: string): Promise<Challenge | null> {
    const key = encodeURIComponent(`c402:challenge:${nonce}`)
    const res = await this.call(`get/${key}`)
    if (typeof res !== 'string') return null
    try {
      const parsed = JSON.parse(res) as Challenge
      if (typeof parsed?.nonce !== 'string' || !Number.isSafeInteger(parsed?.amountCents)) return null
      return parsed
    } catch { return null }
  }

  async patch(nonce: string, fields: Partial<Challenge>, ttlSeconds: number): Promise<void> {
    const current = await this.get(nonce)
    if (!current) return
    const key = encodeURIComponent(`c402:challenge:${nonce}`)
    const value = encodeURIComponent(JSON.stringify({ ...current, ...fields }))
    await this.call(`set/${key}/${value}?EX=${ttlSeconds}`)
  }

  async claimOnce(nonce: string, ttlSeconds: number): Promise<boolean> {
    const key = encodeURIComponent(`c402:paid:${nonce}`)
    const res = await this.call(`set/${key}/${Date.now()}?EX=${ttlSeconds}&NX=true`)
    return res === 'OK'
  }

  /** Idempotent (DEL of a missing key returns 0, not an error). */
  async releaseClaim(nonce: string): Promise<void> {
    await this.call(`del/${encodeURIComponent(`c402:paid:${nonce}`)}`)
  }

  async incr(key: string, by: number, ttlSeconds: number): Promise<number | null> {
    const k = encodeURIComponent(key)
    const res = await this.call(`incrby/${k}/${by}`)
    if (res === null) return null
    await this.call(`expire/${k}/${ttlSeconds}`)
    return typeof res === 'number' ? res : Number(res)
  }

  async setJson(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    const k = encodeURIComponent(key)
    await this.call(`set/${k}/${encodeURIComponent(JSON.stringify(value))}?EX=${ttlSeconds}`)
  }

  async getJson<T>(key: string): Promise<T | null> {
    const res = await this.call(`get/${encodeURIComponent(key)}`)
    if (typeof res !== 'string') return null
    try { return JSON.parse(res) as T } catch { return null }
  }

  async getNumber(key: string): Promise<number | null> {
    const res = await this.call(`get/${encodeURIComponent(key)}`)
    if (res === null) return null
    return typeof res === 'number' ? res : Number(res)
  }
}
