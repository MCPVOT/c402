import { createHash, timingSafeEqual } from 'node:crypto'
import type { SettlementEvent } from '../types.js'

export interface WompiEventPayload {
  event?: { type?: string; timestamp?: number }
  data?: {
    transaction?: {
      id?: string
      status?: string
      reference?: string
      amount_in_cents?: number
      currency?: string
    }
  }
}

export const WOMPI_CHECKSUM_HEADER = 'x-event-checksum'

/** SHA-256(rawBody + eventsSecret) as lowercase hex. */
export function computeEventChecksum(rawBody: string, eventsSecret: string): string {
  return createHash('sha256').update(rawBody + eventsSecret).digest('hex')
}

/**
 * Verify the Wompi event checksum over the RAW request body.
 * Constant-time comparison; returns false for any malformed input.
 */
export function verifyEventChecksum(rawBody: string, checksum: string | null | undefined, eventsSecret: string): boolean {
  if (!checksum || !eventsSecret) return false
  const expected = computeEventChecksum(rawBody, eventsSecret)
  if (!/^[0-9a-f]+$/i.test(checksum)) return false
  const a = Buffer.from(checksum.toLowerCase(), 'hex')
  const b = Buffer.from(expected, 'hex')
  if (a.length !== b.length || a.length === 0) return false
  return timingSafeEqual(a, b)
}

/** c402 challenge references are `c402_<nonce>`. */
export function buildChallengeReference(nonce: string): string {
  return `c402_${nonce}`
}

/** Extract the nonce from any provider reference, or null when it is not a c402 challenge. */
export function parseNonceFromReference(reference: string | null | undefined): string | null {
  if (!reference || !reference.startsWith('c402_')) return null
  const nonce = reference.slice('c402_'.length)
  return nonce.length > 0 ? nonce : null
}

export function isApprovedStatus(status: string | null | undefined): boolean {
  return status === 'APPROVED' || status === 'COMPLETED'
}

/** Normalise a Wompi webhook payload into a c402 SettlementEvent. */
export function parseWompiEvent(payload: WompiEventPayload): SettlementEvent | null {
  const tx = payload?.data?.transaction
  if (!tx?.id || !tx.reference) return null
  if (!Number.isSafeInteger(tx.amount_in_cents)) return null
  return {
    reference: tx.reference,
    status: tx.status ?? '',
    amountInCents: tx.amount_in_cents as number,
    currency: tx.currency ?? '',
    transactionId: tx.id,
  }
}

export interface CheckoutUrlOptions {
  publicKey: string
  amountCents: number
  reference: string
  redirectUrl: string
  currency?: string
}

/** Build the Wompi Web Checkout URL for a challenge. */
export function buildCheckoutUrl(opts: CheckoutUrlOptions): string {
  const params = new URLSearchParams({
    'public-key': opts.publicKey,
    currency: opts.currency ?? 'COP',
    'amount-in-cents': String(opts.amountCents),
    reference: opts.reference,
    'redirect-url': opts.redirectUrl,
  })
  return `https://checkout.wompi.co/p/?${params.toString()}`
}
