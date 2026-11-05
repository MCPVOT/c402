import type { Challenge } from './types.js'
import { C402_PROTOCOL_VERSION } from './discovery.js'

export const C402_HEADERS = {
  challenge: 'X-402-Challenge',
  paymentId: 'X-402-Payment-Id',
  version: 'X-402-Version',
  retryAfter: 'Retry-After',
} as const

export interface ChallengePayload {
  /** Protocol version, so a client can refuse a challenge it cannot parse. */
  version: string
  nonce: string
  amountCents: number
  currency: string
  calls: number
  expiresAt: string
  paymentUrl: string
  /** Where to poll a started payment. Optional: not every deployment serves it. */
  statusUrl?: string
}

export interface ChallengePayloadOptions {
  statusUrl?: string
  version?: string
}

/** Build the JSON payload carried in the X-402-Challenge header and the 402 body. */
export function buildChallengePayload(
  challenge: Challenge,
  paymentUrl: string,
  opts: ChallengePayloadOptions = {},
): ChallengePayload {
  const payload: ChallengePayload = {
    version: opts.version ?? C402_PROTOCOL_VERSION,
    nonce: challenge.nonce,
    amountCents: challenge.amountCents,
    currency: challenge.currency,
    calls: challenge.calls,
    expiresAt: challenge.expiresAt,
    paymentUrl,
  }
  if (opts.statusUrl) payload.statusUrl = opts.statusUrl
  return payload
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
    // Version is required in 2.1+ payloads. A payload without it is still
    // accepted so already-deployed 2.0 clients keep working, but a payload that
    // names a different MAJOR version is refused rather than guessed at.
    if (parsed.version !== undefined) {
      if (typeof parsed.version !== 'string') return null
      if (parsed.version.split('.')[0] !== C402_PROTOCOL_VERSION.split('.')[0]) return null
    }
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
