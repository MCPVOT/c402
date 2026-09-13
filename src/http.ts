import type { Challenge } from './types.js'

export const C402_HEADERS = {
  challenge: 'X-402-Challenge',
  paymentId: 'X-402-Payment-Id',
  retryAfter: 'Retry-After',
} as const

export interface ChallengePayload {
  nonce: string
  amountCents: number
  currency: string
  calls: number
  expiresAt: string
  paymentUrl: string
}

/** Build the JSON payload carried in the X-402-Challenge header and the 402 body. */
export function buildChallengePayload(challenge: Challenge, paymentUrl: string): ChallengePayload {
  return {
    nonce: challenge.nonce,
    amountCents: challenge.amountCents,
    currency: challenge.currency,
    calls: challenge.calls,
    expiresAt: challenge.expiresAt,
    paymentUrl,
  }
}

/** Serialise compactly for a header value. */
export function encodeChallengeHeader(payload: ChallengePayload): string {
  return JSON.stringify(payload)
}

/** Parse and validate a challenge header. Returns null when malformed. */
export function parseChallengeHeader(raw: string | null | undefined): ChallengePayload | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as ChallengePayload
    if (typeof parsed?.nonce !== 'string') return null
    if (!Number.isSafeInteger(parsed?.amountCents)) return null
    if (typeof parsed?.currency !== 'string') return null
    return parsed
  } catch { return null }
}

/** Standard 402 response body. */
export function build402Body(payload: ChallengePayload, message = 'Payment required.') {
  return {
    error: 'payment_required',
    message,
    c402: payload,
  }
}
