import type { Challenge, ChallengeStore } from '../types.js'

interface Entry { value: unknown; expiresAt: number }

/**
 * In-process store for tests, local development and single-instance deployments.
 *
 * Atomicity: Node runs JS on one thread, so a check-and-set that contains no
 * `await` between the read and the write is atomic with respect to other tasks.
 * claimOnce() below is written that way on purpose.
 */
export class MemoryStore implements ChallengeStore {
  private readonly map = new Map<string, Entry>()
  readonly available = true

  private read<T>(key: string): T | null {
    const e = this.map.get(key)
    if (!e) return null
    if (e.expiresAt <= Date.now()) { this.map.delete(key); return null }
    return e.value as T
  }

  private write(key: string, value: unknown, ttlSeconds: number): void {
    this.map.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 })
  }

  async put(challenge: Challenge, ttlSeconds: number): Promise<void> {
    const key = `c402:challenge:${challenge.nonce}`
    if (this.read<Challenge>(key)) throw new Error('c402: nonce already exists')
    this.write(key, challenge, ttlSeconds)
  }

  async get(nonce: string): Promise<Challenge | null> {
    return this.read<Challenge>(`c402:challenge:${nonce}`)
  }

  async patch(nonce: string, fields: Partial<Challenge>, ttlSeconds: number): Promise<void> {
    const key = `c402:challenge:${nonce}`
    const current = this.read<Challenge>(key)
    if (!current) return
    this.write(key, { ...current, ...fields }, ttlSeconds)
  }

  /** Atomic claim: no await between read and write. */
  async claimOnce(nonce: string, ttlSeconds: number): Promise<boolean> {
    const key = `c402:paid:${nonce}`
    if (this.read<number>(key) !== null) return false
    this.write(key, Date.now(), ttlSeconds)
    return true
  }

  /** Idempotent: removing a claim that is not there is not an error. */
  async releaseClaim(nonce: string): Promise<void> {
    this.map.delete(`c402:paid:${nonce}`)
  }

  async incr(key: string, by: number, ttlSeconds: number): Promise<number | null> {
    const current = this.read<number>(key) ?? 0
    const next = current + by
    this.write(key, next, ttlSeconds)
    return next
  }

  async getNumber(key: string): Promise<number | null> {
    return this.read<number>(key)
  }

  async setJson(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    this.write(key, value, ttlSeconds)
  }

  async getJson<T>(key: string): Promise<T | null> {
    return this.read<T>(key)
  }
}
