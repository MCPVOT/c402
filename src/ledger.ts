import type { ChallengeStore, CreditLedger } from './types.js'

const CREDITS_PREFIX = 'c402:credits:'
const DEFAULT_TTL_SECONDS = 86400 * 90

/**
 * Prepaid credit ledger over a ChallengeStore.
 *
 * deduct() is a single atomic INCRBY followed by a compensating rollback when the
 * result goes negative. That keeps the common path to one round trip. For
 * multi-region or high-concurrency deployments use a Lua/EVAL store method
 * instead (see CONFORMANCE.md, "Ledger atomicity").
 */
export class StoreCreditLedger implements CreditLedger {
  constructor(
    private readonly store: ChallengeStore,
    private readonly ttlSeconds: number = DEFAULT_TTL_SECONDS,
  ) {}

  private key(apiKeyId: string): string { return CREDITS_PREFIX + apiKeyId }

  async add(apiKeyId: string, credits: number): Promise<number> {
    if (!Number.isSafeInteger(credits) || credits <= 0) throw new RangeError('credits must be a positive integer')
    const next = await this.store.incr(this.key(apiKeyId), credits, this.ttlSeconds)
    if (next === null) throw new Error('c402: credit ledger unavailable')
    return next
  }

  async balance(apiKeyId: string): Promise<number> {
    return (await this.store.getNumber(this.key(apiKeyId))) ?? 0
  }

  async deduct(apiKeyId: string): Promise<number> {
    const remaining = await this.store.incr(this.key(apiKeyId), -1, this.ttlSeconds)
    if (remaining === null) throw new Error('c402: credit ledger unavailable')
    if (remaining < 0) {
      await this.store.incr(this.key(apiKeyId), 1, this.ttlSeconds)
      return -1
    }
    return remaining
  }
}
