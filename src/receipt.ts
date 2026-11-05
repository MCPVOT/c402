import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import type { Challenge, SettlementEvent } from './types.js'

/**
 * c402 P5 - signed payment receipts.
 *
 * A receipt is the buyer's proof that a challenge settled, verifiable offline by
 * any third party that shares the receipt secret. That is what lets an agent,
 * a CLI or another service check "this grant is real" without calling the API
 * that issued it, and without trusting that API's logs.
 *
 * The signing input is a line-oriented canonical form, not JSON. JSON has too
 * many equally valid encodings (key order, whitespace, number formatting), and a
 * signature that disagrees between two languages because of serialisation is
 * worse than no signature. Every field is on its own `name=value` line, values
 * are never escaped, and the first line is the version tag.
 *
 * Any change to the field list or the separators is a new version tag.
 */
export const RECEIPT_VERSION = 'c402-receipt-v1'

export interface ReceiptPayload {
  /** The challenge nonce this receipt settles. */
  nonce: string
  /** sha256 hex of the API key id. Never the key itself. */
  keyHash: string
  amountCents: number
  currency: string
  calls: number
  transactionId: string
  paidAt: string
  expiresAt: string
}

export type Receipt = ReceiptPayload & { v: typeof RECEIPT_VERSION; sig: string }

export type ReceiptFailure = 'bad_version' | 'malformed' | 'bad_signature'

export type ReceiptVerification = { ok: true } | { ok: false; reason: ReceiptFailure }

/** sha256 hex of an API key id, the only key material a receipt carries. */
export function hashApiKey(apiKeyId: string): string {
  return createHash('sha256').update(apiKeyId, 'utf8').digest('hex')
}

/** Canonical, language-neutral signing input. Keep byte-identical across ports. */
export function receiptSigningInput(payload: ReceiptPayload): string {
  return [
    RECEIPT_VERSION,
    `nonce=${payload.nonce}`,
    `keyHash=${payload.keyHash}`,
    `amountCents=${payload.amountCents}`,
    `currency=${payload.currency.toUpperCase()}`,
    `calls=${payload.calls}`,
    `transactionId=${payload.transactionId}`,
    `paidAt=${payload.paidAt}`,
    `expiresAt=${payload.expiresAt}`,
  ].join('\n')
}

/** Lowercase hex HMAC-SHA256 of the canonical signing input. */
export function signReceiptPayload(payload: ReceiptPayload, secret: string): string {
  if (!secret) throw new Error('c402: receipt secret is required')
  return createHmac('sha256', secret).update(receiptSigningInput(payload), 'utf8').digest('hex')
}

/**
 * Sign a settled challenge. Call this once, after the grant is durable: a
 * receipt is a claim about the past and cannot be unsigned.
 */
export function signReceipt(
  challenge: Challenge,
  event: SettlementEvent,
  secret: string,
  opts: { paidAt?: string } = {},
): Receipt {
  const payload: ReceiptPayload = {
    nonce: challenge.nonce,
    keyHash: hashApiKey(challenge.apiKeyId),
    amountCents: challenge.amountCents,
    currency: challenge.currency,
    calls: challenge.calls,
    transactionId: event.transactionId,
    paidAt: opts.paidAt ?? new Date().toISOString(),
    expiresAt: challenge.expiresAt,
  }
  return { v: RECEIPT_VERSION, ...payload, sig: signReceiptPayload(payload, secret) }
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value)
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

/**
 * Verify a receipt offline: shape, version, then constant-time signature check.
 *
 * `now` is optional and deliberately not used to reject receipts by default; a
 * receipt is proof of a past settlement, and a caller that needs "is this grant
 * still usable" should compare its own clock against the embedded fields.
 */
export function verifyReceipt(
  receipt: unknown,
  secret: string,
  opts: { now?: number } = {},
): ReceiptVerification {
  if (!secret) return { ok: false, reason: 'malformed' }
  if (typeof receipt !== 'object' || receipt === null) return { ok: false, reason: 'malformed' }

  const r = receipt as Partial<Receipt>
  if (r.v !== RECEIPT_VERSION) return { ok: false, reason: 'bad_version' }

  if (
    typeof r.nonce !== 'string' || r.nonce.length === 0 ||
    typeof r.keyHash !== 'string' || !/^[0-9a-f]{64}$/i.test(r.keyHash) ||
    !isSafeInteger(r.amountCents) || r.amountCents <= 0 ||
    typeof r.currency !== 'string' || r.currency.length === 0 ||
    !isSafeInteger(r.calls) || r.calls <= 0 ||
    typeof r.transactionId !== 'string' || r.transactionId.length === 0 ||
    !isIsoTimestamp(r.paidAt) ||
    !isIsoTimestamp(r.expiresAt) ||
    typeof r.sig !== 'string' || !/^[0-9a-f]{64}$/i.test(r.sig)
  ) {
    return { ok: false, reason: 'malformed' }
  }

  if (opts.now !== undefined && Date.parse(r.paidAt) > opts.now + 60_000) {
    // A receipt dated in the future cannot have been produced by a settled
    // payment; allow a small clock skew for distributed issuers.
    return { ok: false, reason: 'malformed' }
  }

  const payload: ReceiptPayload = {
    nonce: r.nonce,
    keyHash: r.keyHash,
    amountCents: r.amountCents,
    currency: r.currency,
    calls: r.calls,
    transactionId: r.transactionId,
    paidAt: r.paidAt,
    expiresAt: r.expiresAt,
  }
  const expected = Buffer.from(signReceiptPayload(payload, secret), 'hex')
  const given = Buffer.from(r.sig.toLowerCase(), 'hex')
  if (expected.length !== given.length || expected.length === 0) return { ok: false, reason: 'malformed' }
  return timingSafeEqual(expected, given) ? { ok: true } : { ok: false, reason: 'bad_signature' }
}
