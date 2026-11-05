import type { Challenge, SettlementEvent, SettleReason } from './types.js'

export type VerifyResult = { ok: true } | { ok: false; reason: SettleReason }

export interface VerifyOptions {
  /** Late-arriving webhooks may settle this long after expiry. Default 86400. */
  graceSeconds?: number
  /** Provider statuses that mean money actually moved. */
  allowedStatuses?: readonly string[]
  /** Injectable clock for tests. */
  now?: number
}

export const DEFAULT_SETTLEABLE_STATUSES: readonly string[] = ['APPROVED', 'COMPLETED'] as const

/**
 * Server-side settlement verification. Runs BEFORE any credit is granted.
 *
 * Checks, in order:
 *  1. status means money moved
 *  2. amount matches the stored challenge exactly (integer minor units)
 *  3. currency matches the stored challenge
 *  4. the challenge has not passed its settlement grace window
 *
 * Never trust the checkout URL, the reference, or client claims.
 */
export function verifySettlement(
  challenge: Challenge,
  event: SettlementEvent,
  opts: VerifyOptions = {},
): VerifyResult {
  const allowed = opts.allowedStatuses ?? DEFAULT_SETTLEABLE_STATUSES
  const now = opts.now ?? Date.now()
  const grace = opts.graceSeconds ?? 86400

  if (!allowed.includes(event.status)) return { ok: false, reason: 'invalid_status' }

  if (!Number.isSafeInteger(event.amountInCents)) return { ok: false, reason: 'amount_mismatch' }
  if (event.amountInCents !== challenge.amountCents) return { ok: false, reason: 'amount_mismatch' }

  if ((event.currency || '').toUpperCase() !== challenge.currency.toUpperCase()) {
    return { ok: false, reason: 'currency_mismatch' }
  }

  const expiresAt = Date.parse(challenge.expiresAt)
  // Fail closed: an unparseable TTL must never be read as "still valid".
  if (!Number.isFinite(expiresAt)) return { ok: false, reason: 'invalid_challenge' }
  if (now > expiresAt + grace * 1000) {
    return { ok: false, reason: 'expired_beyond_grace' }
  }

  return { ok: true }
}
