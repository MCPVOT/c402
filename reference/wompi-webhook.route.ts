import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'
import { prisma } from '@/lib/db'
import { redis } from '@/lib/redis'
import type { PaymentStatus } from '@prisma/client'

export const maxDuration = 30
export const dynamic = 'force-dynamic'

const IDEMPOTENCY_TTL = 86_400 // 24 hours — events older than this are safe to reprocess
const IDEMPOTENCY_PREFIX = 'wompi:event:'

function verifyChecksum(rawBody: string, checksum: string): boolean {
  const eventsSecret = process.env.WOMPI_EVENTS_SECRET
  if (!eventsSecret) return false

  const computed = crypto
    .createHash('sha256')
    .update(rawBody + eventsSecret)
    .digest('hex')

  const expectedBuf = Buffer.from(checksum, 'hex')
  const computedBuf = Buffer.from(computed, 'hex')

  if (expectedBuf.length !== computedBuf.length) return false
  return crypto.timingSafeEqual(expectedBuf, computedBuf)
}

export async function POST(req: NextRequest) {
  try {
    const checksum = req.headers.get('x-event-checksum') || ''
    const rawBody = await req.text()

    if (!checksum) {
      return NextResponse.json(
        { error: 'Missing x-event-checksum header' },
        { status: 401 }
      )
    }

    if (!verifyChecksum(rawBody, checksum)) {
      return NextResponse.json(
        { error: 'Invalid checksum' },
        { status: 401 }
      )
    }

    const payload = JSON.parse(rawBody) as {
      event: { type: string; timestamp: number }
      data: {
        transaction: {
          id: string
          status: string
          reference: string
          amount_in_cents: number
          currency: string
          payment_method_type?: string
        }
      }
    }

    const eventType = payload.event?.type
    const eventTimestamp = payload.event?.timestamp
    const transaction = payload.data?.transaction

    if (!eventType || !transaction?.id) {
      return NextResponse.json(
        { error: 'Invalid Wompi event payload' },
        { status: 400 }
      )
    }

    if (eventType !== 'transaction.updated') {
      return NextResponse.json({ received: true })
    }

    // ── Idempotency check: reject duplicate events (replay prevention) ──
    const idempotencyKey = `${IDEMPOTENCY_PREFIX}${transaction.id}:${eventTimestamp || eventType}`
    if (redis) {
      const alreadyProcessed = await redis.get(idempotencyKey)
      if (alreadyProcessed) {
        console.warn(`[Wompi] Duplicate event rejected: ${idempotencyKey}`)
        return NextResponse.json({ received: true, deduplicated: true })
      }
      // Mark as processed with TTL
      await redis.set(idempotencyKey, '1', { ex: IDEMPOTENCY_TTL })
    }

    const wompiTransactionId = transaction.id
    const wompiStatus = transaction.status

    const paymentByExternal = await prisma.payment.findFirst({
      where: { externalId: wompiTransactionId },
    })

    let targetPayment = paymentByExternal

    if (!targetPayment && transaction.reference) {
      const ref = transaction.reference.replace('pay_', '')
      targetPayment = await prisma.payment.findUnique({
        where: { id: ref },
      })
    }

    // ── c402 HTTP 402 Payment Challenge ──
    if (!targetPayment && transaction.reference && transaction.reference.startsWith('c402_')) {
      const { getChallenge, markAsPaid } = await import('@/lib/c402/challenge')
      const { addCredits } = await import('@/lib/credits/ledger')
      const nonce = transaction.reference.replace('c402_', '')

      if (wompiStatus !== 'APPROVED' && wompiStatus !== 'COMPLETED') {
        return NextResponse.json({ received: true })
      }

      const c402 = await import('@/lib/c402/challenge')
      const challenge = await c402.getChallenge(nonce)
      if (challenge?.paid) {
        // Already processed — return 200 (Wompi retries need idempotent response)
        return NextResponse.json({ received: true, alreadyProcessed: true })
      }
      if (!challenge) {
        console.warn(`[c402] Settlement rejected: unknown challenge ${nonce}`)
        return NextResponse.json({ error: 'Challenge not found' }, { status: 404 })
      }

      // ── Server-side settlement verification (c402 v2): amount + currency MUST
      //    match the stored challenge exactly. Prevents underpaid/malformed
      //    transactions from granting credits. ──
      const settlement = c402.verifySettlement(
        challenge,
        { amount_in_cents: transaction.amount_in_cents, currency: transaction.currency },
      )
      if (!settlement.ok) {
        console.error(`[c402] Settlement mismatch for ${nonce}: ${settlement.reason}`)
        return NextResponse.json({ error: 'Payment amount mismatch' }, { status: 409 })
      }

      // Atomic claim — concurrent webhook retries cannot double-grant (v2)
      const claim = await c402.markAsPaidNx(nonce)
      if (!claim.ok) {
        return NextResponse.json({ received: true, alreadyProcessed: true })
      }
      await addCredits(challenge.apiKeyId, challenge.calls)

      console.log(`[c402] Challenge ${nonce} settled & verified (${transaction.amount_in_cents} ${transaction.currency}): ${challenge.calls} credits to ${challenge.apiKeyId}`)
      return NextResponse.json({ received: true, creditsAdded: challenge.calls })
    }

    // ── API Tier Subscription Purchase (c402 P3) ──
    if (!targetPayment && transaction.reference && transaction.reference.startsWith('subscription_api_')) {
      const { setApiTier, getPurchase, recordPurchase } = await import('@/lib/c402/subscriptions')
      const purchaseId = transaction.reference

      if (wompiStatus !== 'APPROVED' && wompiStatus !== 'COMPLETED') {
        return NextResponse.json({ received: true })
      }

      const purchase = await getPurchase(purchaseId)
      if (!purchase) {
        return NextResponse.json({ error: 'Subscription purchase not found' }, { status: 404 })
      }

      // Idempotency: if already processed, skip
      if (purchase.paidAt) {
        return NextResponse.json({ received: true, alreadyProcessed: true })
      }

      // ── Settlement verification (c402 v2): paid amount must match the
      //    recorded price for this tier. Prevents underpaid tier activation. ──
      const expectedCents = Math.round(purchase.amountCOP ?? Number.NaN)
      if (!Number.isFinite(expectedCents) || transaction.amount_in_cents !== expectedCents) {
        console.error(`[Subscriptions] Amount mismatch for ${purchaseId}: expected ${expectedCents}, got ${transaction.amount_in_cents} ${transaction.currency}`)
        return NextResponse.json({ error: 'Payment amount mismatch' }, { status: 409 })
      }
      if ((transaction.currency || '').toUpperCase() !== 'COP') {
        console.error(`[Subscriptions] Currency mismatch for ${purchaseId}: ${transaction.currency}`)
        return NextResponse.json({ error: 'Currency mismatch' }, { status: 409 })
      }

      await setApiTier(purchase.apiKeyId, purchase.tier, 30)
      // Mark purchase as paid to prevent double-processing on webhook retry
      await recordPurchase(purchaseId, { ...purchase, paidAt: new Date().toISOString() })

      console.log(`[Subscriptions] Tier ${purchase.tier} activated for ${purchase.apiKeyId} via purchase ${purchaseId}`)
      return NextResponse.json({ received: true, tierActivated: purchase.tier })
    }

    // ── Credit Pack Purchase (c402 prepaid credits) ──
    if (!targetPayment && transaction.reference && transaction.reference.startsWith('credit_')) {
      const { addCredits, getPurchase, recordPurchase } = await import('@/lib/credits/ledger')
      const purchaseId = transaction.reference

      if (wompiStatus !== 'APPROVED' && wompiStatus !== 'COMPLETED') {
        return NextResponse.json({ received: true })
      }

      const purchase = await getPurchase(purchaseId)
      if (!purchase) {
        return NextResponse.json({ error: 'Credit purchase not found' }, { status: 404 })
      }

      // Idempotency: if already processed, skip (prevents double-add on Wompi retry)
      if (purchase.paidAt) {
        return NextResponse.json({ received: true, alreadyProcessed: true })
      }

      await addCredits(purchase.apiKeyId, purchase.calls)
      // Mark purchase as paid to prevent double-processing
      await recordPurchase(purchaseId, { ...purchase, paidAt: new Date().toISOString() })

      console.log(`[Credits] Added ${purchase.calls} credits to ${purchase.apiKeyId} via purchase ${purchaseId}`)
      return NextResponse.json({ received: true, creditsAdded: purchase.calls })
    }

    if (!targetPayment) {
      return NextResponse.json(
        { error: 'Payment not found' },
        { status: 404 }
      )
    }

    if (targetPayment.status === 'COMPLETED' || targetPayment.status === 'REFUNDED') {
      return NextResponse.json({ received: true })
    }

    const expectedAmountInCents = Math.round(targetPayment.amount * 100)
    if (
      transaction.amount_in_cents !== expectedAmountInCents ||
      transaction.currency !== 'COP'
    ) {
      console.error(
        `Amount mismatch for payment ${targetPayment.id}: expected ${expectedAmountInCents} COP, got ${transaction.amount_in_cents} ${transaction.currency}`
      )
      return NextResponse.json(
        { error: 'Amount mismatch' },
        { status: 400 }
      )
    }

    let newStatus: PaymentStatus = targetPayment.status as PaymentStatus
    let paidAt: Date | null = targetPayment.paidAt

    if (wompiStatus === 'APPROVED' || wompiStatus === 'COMPLETED') {
      newStatus = 'COMPLETED'
      paidAt = new Date()
    } else if (
      wompiStatus === 'DECLINED' ||
      wompiStatus === 'ERROR' ||
      wompiStatus === 'VOIDED'
    ) {
      newStatus = 'FAILED'
    } else if (wompiStatus === 'REFUNDED') {
      newStatus = 'REFUNDED'
    }

    if (newStatus !== targetPayment.status) {
      await prisma.payment.update({
        where: { id: targetPayment.id },
        data: {
          status: newStatus,
          paidAt,
          externalId: wompiTransactionId,
          providerMetadata: JSON.stringify({
            ...(typeof targetPayment.providerMetadata === 'string'
              ? JSON.parse(targetPayment.providerMetadata)
              : typeof targetPayment.providerMetadata === 'object' && targetPayment.providerMetadata
                ? targetPayment.providerMetadata
                : {}),
            wompiEvent: eventType,
            wompiStatus,
            wompiTransactionId,
            updatedAt: new Date().toISOString(),
          }),
        },
      })

      if (
        newStatus === 'COMPLETED' &&
        targetPayment.paymentType === 'LISTING_FEE' &&
        targetPayment.propertyId
      ) {
        await prisma.property.update({
          where: { id: targetPayment.propertyId },
          data: { listingTier: 'COMPLEX' },
        })
      }

      if (
        newStatus === 'COMPLETED' &&
        targetPayment.paymentType === 'COMMISSION' &&
        targetPayment.tenancyId
      ) {
        await prisma.commission.updateMany({
          where: { tenancyId: targetPayment.tenancyId },
          data: { paid: true, paidAt: new Date() },
        })
      }
    }

    return NextResponse.json({ received: true })
  } catch (error: unknown) {
    console.error('[Wompi Webhook] Error:', error instanceof Error ? error.message : String(error))
    return NextResponse.json({ error: 'Error al procesar webhook de pago.' }, { status: 500 })
  }
}
