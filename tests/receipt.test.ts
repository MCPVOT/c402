import { describe, expect, it } from 'vitest'
import {
  RECEIPT_VERSION,
  hashApiKey,
  normalizeReceiptText,
  parseReceiptText,
  receiptSigningInput,
  signReceipt,
  signReceiptPayload,
  verifyReceipt,
  verifyReceiptText,
  type Receipt,
  type ReceiptPayload,
} from '../src/receipt.js'
import type { Challenge, SettlementEvent } from '../src/types.js'

/**
 * CROSS-LANGUAGE VECTOR.
 * These exact bytes are asserted again by rust/c402-verify/tests/vector.rs.
 * If either side changes the canonical form, both suites fail together.
 */
const SECRET = 'test-secret-0123456789'
const VECTOR: ReceiptPayload = {
  nonce: 'b3f1c9e2-9a4d-4f61-8b3a-9f1e0d7c2a55',
  keyHash: 'be2974546978e3739e6d6da85c4be9f334ce32df2b9fd4b6ff1b55c0d57e9d44',
  amountCents: 250000,
  currency: 'COP',
  calls: 50,
  transactionId: 'tx-001',
  paidAt: '2026-08-24T21:00:00.000Z',
  expiresAt: '2026-08-24T21:30:00.000Z',
}
const VECTOR_SIG = '35c7221a55287b72eef382b4b439f24af400c5e5c531c4c4a925032627e44d14'

const challenge = (over: Partial<Challenge> = {}): Challenge => ({
  nonce: VECTOR.nonce,
  apiKeyId: 'key-1',
  amountCents: 250000,
  currency: 'COP',
  calls: 50,
  createdAt: '2026-08-24T20:30:00.000Z',
  expiresAt: VECTOR.expiresAt,
  paid: true,
  settledTransactionId: 'tx-001',
  ...over,
})

const event: SettlementEvent = {
  reference: `c402_${VECTOR.nonce}`,
  status: 'APPROVED',
  amountInCents: VECTOR.amountCents,
  currency: 'COP',
  transactionId: VECTOR.transactionId,
}

describe('receipt canonical form', () => {
  it('hashes the API key id rather than carrying the key', () => {
    expect(hashApiKey('key-1')).toBe(VECTOR.keyHash)
    expect(hashApiKey('key-2')).not.toBe(VECTOR.keyHash)
  })

  it('signs the documented canonical string', () => {
    expect(receiptSigningInput(VECTOR)).toBe(
      [
        RECEIPT_VERSION,
        `nonce=${VECTOR.nonce}`,
        `keyHash=${VECTOR.keyHash}`,
        `amountCents=${VECTOR.amountCents}`,
        `currency=${VECTOR.currency}`,
        `calls=${VECTOR.calls}`,
        `transactionId=${VECTOR.transactionId}`,
        `paidAt=${VECTOR.paidAt}`,
        `expiresAt=${VECTOR.expiresAt}`,
      ].join('\n'),
    )
  })

  it('matches the cross-language vector signature', () => {
    expect(signReceiptPayload(VECTOR, SECRET)).toBe(VECTOR_SIG)
  })
})

describe('signReceipt / verifyReceipt', () => {
  it('round-trips a settled challenge', () => {
    const r = signReceipt(challenge(), event, SECRET, { paidAt: VECTOR.paidAt })
    expect(r.v).toBe(RECEIPT_VERSION)
    expect(r.sig).toBe(VECTOR_SIG)
    expect(verifyReceipt(r, SECRET)).toEqual({ ok: true })
  })

  it('verifies the vector receipt offline', () => {
    expect(verifyReceipt({ v: RECEIPT_VERSION, ...VECTOR, sig: VECTOR_SIG }, SECRET)).toEqual({ ok: true })
  })

  it('rejects any tampered field', () => {
    const base: Receipt = { v: RECEIPT_VERSION, ...VECTOR, sig: VECTOR_SIG }
    const mutations: Array<Partial<Receipt>> = [
      { amountCents: 1 },
      { calls: 5000 },
      { currency: 'USD' },
      { transactionId: 'tx-002' },
      { keyHash: hashApiKey('other-key') },
      { nonce: 'c'.repeat(36) },
      { expiresAt: '2027-08-24T21:30:00.000Z' },
    ]
    for (const mutation of mutations) {
      expect(verifyReceipt({ ...base, ...mutation }, SECRET)).toEqual({ ok: false, reason: 'bad_signature' })
    }
  })

  it('rejects the wrong secret', () => {
    const r = signReceipt(challenge(), event, SECRET, { paidAt: VECTOR.paidAt })
    expect(verifyReceipt(r, 'another-secret')).toEqual({ ok: false, reason: 'bad_signature' })
  })

  it('rejects a different receipt version', () => {
    expect(verifyReceipt({ v: 'c402-receipt-v2', ...VECTOR, sig: VECTOR_SIG }, SECRET)).toEqual({
      ok: false,
      reason: 'bad_version',
    })
  })

  it('rejects malformed receipts without throwing', () => {
    for (const bad of [null, undefined, 42, 'nope']) {
      expect(verifyReceipt(bad, SECRET)).toEqual({ ok: false, reason: 'malformed' })
    }
    // an object that names no version is a version failure, not a shape failure
    expect(verifyReceipt({}, SECRET)).toEqual({ ok: false, reason: 'bad_version' })
    expect(verifyReceipt({ v: RECEIPT_VERSION }, SECRET)).toEqual({ ok: false, reason: 'malformed' })
    expect(verifyReceipt({ v: RECEIPT_VERSION, ...VECTOR, sig: 'zz' }, SECRET)).toEqual({
      ok: false,
      reason: 'malformed',
    })
    expect(verifyReceipt({ v: RECEIPT_VERSION, ...VECTOR, sig: VECTOR_SIG }, '')).toEqual({
      ok: false,
      reason: 'malformed',
    })
  })

  it('rejects a receipt dated in the future when a clock is supplied', () => {
    const r = signReceipt(challenge(), event, SECRET, { paidAt: VECTOR.paidAt })
    const now = Date.parse(VECTOR.paidAt) - 10 * 60_000
    expect(verifyReceipt(r, SECRET, { now })).toEqual({ ok: false, reason: 'malformed' })
  })

  it('accepts small clock skew', () => {
    const r = signReceipt(challenge(), event, SECRET, { paidAt: VECTOR.paidAt })
    const now = Date.parse(VECTOR.paidAt) - 10_000
    expect(verifyReceipt(r, SECRET, { now })).toEqual({ ok: true })
  })
})

describe('cross-platform receipt text (Windows and Linux)', () => {
  const canonical = receiptSigningInput(VECTOR)
  const text = (eol: string) => canonical.split('\n').join(eol) + eol + `sig=${VECTOR_SIG}` + eol

  it('verifies an LF receipt', () => {
    expect(verifyReceiptText(text('\n'), SECRET)).toEqual({ ok: true })
  })

  it('verifies a CRLF receipt written on Windows', () => {
    expect(verifyReceiptText(text('\r\n'), SECRET)).toEqual({ ok: true })
  })

  it('verifies a receipt with a UTF-8 BOM', () => {
    expect(verifyReceiptText('\uFEFF' + text('\r\n'), SECRET)).toEqual({ ok: true })
  })

  it('verifies a receipt with no trailing newline', () => {
    expect(verifyReceiptText(text('\n').trimEnd(), SECRET)).toEqual({ ok: true })
  })

  it('still rejects a tampered CRLF receipt', () => {
    const tampered = text('\r\n').replace('amountCents=250000', 'amountCents=1')
    expect(verifyReceiptText(tampered, SECRET)).toEqual({ ok: false, reason: 'bad_signature' })
  })

  it('parses the text form into the same payload', () => {
    const parsed = parseReceiptText(text('\r\n'))
    expect(parsed?.payload).toEqual(VECTOR)
    expect(parsed?.sig).toBe(VECTOR_SIG)
  })

  it('rejects text with no sig line or the wrong version', () => {
    expect(verifyReceiptText(canonical, SECRET)).toEqual({ ok: false, reason: 'malformed' })
    expect(verifyReceiptText(text('\n').replace(RECEIPT_VERSION, 'c402-receipt-v9'), SECRET)).toEqual({
      ok: false,
      reason: 'malformed',
    })
  })

  it('normalises CRLF and BOM without touching field values', () => {
    expect(normalizeReceiptText('\uFEFFa\r\nb\rc\n\n')).toBe('a\nb\nc')
  })
})
