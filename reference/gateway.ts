/**
 * c402 API Gateway Helper
 *
 * Wraps v1 API endpoints with c402 payment challenge support.
 * When FREE tier rate limit is exceeded and no prepaid credits:
 * 1. Try deduct a prepaid credit
 * 2. If no credits → HTTP 402 with X-402-Challenge
 *
 * Usage in v1 routes:
 *   const c402 = await checkC402(auth.apiKey, req)
 *   if (c402.status === 'pay') return c402.response
 *   if (c402.status === 'allow') { ... proceed ... }
 */
import { NextRequest, NextResponse } from 'next/server'
import { getCreditBalance, deductCredit } from '@/lib/credits/ledger'
import { createChallenge, calculatePrice } from '@/lib/c402/challenge'
import type { AuthenticatedApiRequest } from '@/lib/middleware/api-auth'

const MIN_CALLS_FOR_402 = 50 // Minimum calls to request in a 402 challenge

interface C402ResultAllow {
  status: 'allow'
}

interface C402ResultPay {
  status: 'pay'     // Real HTTP 402 payment challenge
  response: NextResponse
}

interface C402ResultBlocked {
  status: 'blocked' // Rate limited (not a payment challenge)
  response: NextResponse
}

interface C402ResultSkip {
  status: 'skip'    // Normal operation, proceed
}

export type C402Result = C402ResultAllow | C402ResultPay | C402ResultBlocked | C402ResultSkip

/**
 * Check if request should trigger c402 payment challenge.
 * Only applies to FREE tier users.
 */
export async function checkC402(
  apiKey: AuthenticatedApiRequest['apiKey'],
  req: NextRequest,
): Promise<C402Result> {
  // Only FREE tier gets 402 challenges
  if (apiKey.tier !== 'FREE') {
    return { status: 'skip' }
  }

  // Try prepaid credits first
  const balance = await getCreditBalance(apiKey.id)
  if (balance > 0) {
    const remaining = await deductCredit(apiKey.id)
    if (remaining >= 0) {
      // Successfully used a prepaid credit — allow the request
      return { status: 'allow' }
    }
  }

  // No prepaid credits — create payment challenge
  const { amount, calls } = calculatePrice(MIN_CALLS_FOR_402)
  const challenge = await createChallenge(apiKey.id, amount, calls)

  if (!challenge) {
    // Redis unavailable — fall back to normal rate limit
    return { status: 'skip' }
  }

  // Generate Wompi checkout URL
  const wompiKey = process.env.WOMPI_PUBLIC_KEY || ''
  const checkoutUrl = `https://checkout.wompi.co/p/?public-key=${wompiKey}&currency=COP&amount-in-cents=${amount}&reference=c402_${challenge.nonce}&redirect-url=${encodeURIComponent(process.env.NEXT_PUBLIC_APP_URL || 'https://xpequi.xyz')}/developers`

  return {
    status: 'pay',
    response: NextResponse.json(
      {
        error: 'payment_required',
        message: 'Has excedido tu límite gratuito. Paga por más llamadas API.',
        c402: {
          nonce: challenge.nonce,
          amount: challenge.amount,
          currency: 'COP',
          calls: challenge.calls,
          expiresAt: challenge.expiresAt,
          paymentUrl: checkoutUrl,
        },
      },
      {
        status: 402,
        headers: {
          'X-402-Challenge': JSON.stringify({
            nonce: challenge.nonce,
            amount: challenge.amount,
            currency: 'COP',
            calls: challenge.calls,
            paymentUrl: checkoutUrl,
          }),
        },
      },
    ),
  }
}
