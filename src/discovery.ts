import type { Challenge } from './types.js'

/**
 * Machine-readable discovery and status, the parts an autonomous agent needs
 * before it can decide to pay.
 *
 * Without this, an agent holding a 402 has to be hand-coded against one API:
 * it cannot tell what rails exist, whether a receipt will be issued, or how to
 * poll a payment it has already started. The discovery document is meant to be
 * served at `/.well-known/c402.json`; the status projection backs a
 * `GET /c402/status/<nonce>` endpoint.
 */
export const C402_PROTOCOL_VERSION = '2.2'
export const DISCOVERY_PATH = '/.well-known/c402.json'

export const RAILS = ['wompi', 'pse', 'nequi', 'daviplata', 'bancolombia_transfer'] as const
export type Rail = (typeof RAILS)[number]

export interface DiscoveryDocument {
  protocol: 'c402'
  version: string
  currency: string
  challenge: {
    header: string
    /** TTL a challenge stays payable for, in seconds. */
    ttlSeconds: number
    /** Grace after expiry during which a settled challenge can still be redeemed. */
    redemptionGraceSeconds: number
    /** Max unpaid challenges per API key. */
    maxOutstandingPerKey: number
  }
  settlement: {
    /** Statuses that mean money moved. */
    settleableStatuses: readonly string[]
    /** Webhooks may settle this long after expiry. */
    graceSeconds: number
    /** Atomic claim primitive required of every store. */
    claim: 'SET NX'
  }
  receipt: {
    supported: boolean
    algorithm: 'HMAC-SHA256' | null
    version: string | null
  }
  rails: readonly Rail[]
  endpoints: {
    status: string
    discovery: string
  }
}

export interface DiscoveryOptions {
  currency?: string
  ttlSeconds?: number
  redemptionGraceSeconds?: number
  settlementGraceSeconds?: number
  maxOutstandingPerKey?: number
  rails?: readonly Rail[]
  receipt?: { supported: boolean; version?: string }
  statusEndpoint?: string
}

export function buildDiscoveryDocument(opts: DiscoveryOptions = {}): DiscoveryDocument {
  const receipt = opts.receipt ?? { supported: false }
  return {
    protocol: 'c402',
    version: C402_PROTOCOL_VERSION,
    currency: opts.currency ?? 'COP',
    challenge: {
      header: 'X-402-Challenge',
      ttlSeconds: opts.ttlSeconds ?? 1800,
      redemptionGraceSeconds: opts.redemptionGraceSeconds ?? 86400,
      maxOutstandingPerKey: opts.maxOutstandingPerKey ?? 20,
    },
    settlement: {
      settleableStatuses: ['APPROVED', 'COMPLETED'],
      graceSeconds: opts.settlementGraceSeconds ?? 86400,
      claim: 'SET NX',
    },
    receipt: {
      supported: receipt.supported,
      algorithm: receipt.supported ? 'HMAC-SHA256' : null,
      version: receipt.supported ? (receipt.version ?? 'c402-receipt-v1') : null,
    },
    rails: opts.rails ?? RAILS,
    endpoints: {
      status: opts.statusEndpoint ?? '/c402/status/{nonce}',
      discovery: DISCOVERY_PATH,
    },
  }
}

export type PaymentState = 'unknown' | 'pending' | 'paid' | 'expired'

export interface PaymentStatus {
  nonce: string | null
  status: PaymentState
  amountCents: number | null
  currency: string | null
  calls: number | null
  createdAt: string | null
  expiresAt: string | null
  /** Provider transaction id, present once settled. */
  transactionId: string | null
}

/**
 * Pure projection for a status endpoint.
 *
 * A settled challenge reports `paid` even after its expiry: the money moved,
 * and the redemption grace decides whether the client can still spend it. An
 * unpaid challenge past expiry reports `expired`. `unknown` covers both a
 * missing nonce and a store that could not answer - callers that need to tell
 * those apart must check store availability themselves, because a status
 * endpoint that leaks "exists but the store is down" is a probe surface.
 */
export function describePaymentStatus(challenge: Challenge | null, now: number = Date.now()): PaymentStatus {
  if (!challenge) {
    return {
      nonce: null,
      status: 'unknown',
      amountCents: null,
      currency: null,
      calls: null,
      createdAt: null,
      expiresAt: null,
      transactionId: null,
    }
  }

  const expiresAt = Date.parse(challenge.expiresAt)
  const expired = Number.isFinite(expiresAt) && now > expiresAt

  return {
    nonce: challenge.nonce,
    status: challenge.paid ? 'paid' : expired ? 'expired' : 'pending',
    amountCents: challenge.amountCents,
    currency: challenge.currency,
    calls: challenge.calls,
    createdAt: challenge.createdAt,
    expiresAt: challenge.expiresAt,
    transactionId: challenge.settledTransactionId ?? null,
  }
}
