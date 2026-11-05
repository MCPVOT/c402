/**
 * Next.js App Router adapter for c402.
 *
 * Fail-closed: when the challenge store is unreachable and the caller has no
 * prepaid credits, this returns 503 instead of serving the request for free.
 * The v2.0 reference implementation returned `skip` here, which contradicted the
 * spec's fail-closed requirement - do not reintroduce that.
 */
import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
// Import from the published package. A relative ../../src path only resolves
// inside the c402 repository, which made these files uncopyable before.
import {
  calculatePrice,
  MIN_CALLS_FOR_CHALLENGE,
  createChallenge,
  StoreCreditLedger,
  decideAccess,
  build402Body,
  buildChallengePayload,
  C402_HEADERS,
  encodeChallengeHeader,
  buildChallengeReference,
  buildCheckoutUrl,
} from 'c402-protocol'
import type { ChallengeStore } from 'c402-protocol'

export interface C402GatewayDeps {
  store: ChallengeStore
  redirectUrl: string
  wompiPublicKey: string
  failClosed?: boolean
  /** Optional status endpoint template, e.g. "/c402/status/{nonce}". */
  statusUrl?: string
}

export type C402Outcome =
  | { kind: 'allow' }
  | { kind: 'response'; response: NextResponse }

/**
 * Call before handling a FREE-tier request.
 * `apiKeyId` must be the authenticated key id - never a client-supplied value.
 */
export async function checkC402(
  apiKeyId: string,
  deps: C402GatewayDeps,
): Promise<C402Outcome> {
  const ledger = new StoreCreditLedger(deps.store)
  const storeAvailable = deps.store.available !== false
  const failClosed = deps.failClosed ?? true

  let credits = 0
  try {
    credits = await ledger.balance(apiKeyId)
  } catch {
    credits = 0
  }

  const decision = decideAccess({ creditsRemaining: credits, storeAvailable, failClosed })

  if (decision.action === 'allow') {
    const remaining = await ledger.deduct(apiKeyId)
    if (remaining >= 0) return { kind: 'allow' }
    // raced to zero: fall through to a new challenge
  }

  if (decision.action === 'unavailable') {
    return {
      kind: 'response',
      response: NextResponse.json(
        {
          error: 'challenge_store_unavailable',
          code: 'C402_STORE_UNAVAILABLE',
          recoverable: true,
          suggestedAction: 'Retry shortly. The payment challenge store is unreachable.',
        },
        { status: 503, headers: { [C402_HEADERS.retryAfter]: '5', 'Cache-Control': 'no-store' } },
      ),
    }
  }

  const { amountCents, calls } = calculatePrice(MIN_CALLS_FOR_CHALLENGE)

  let challenge
  try {
    challenge = await createChallenge(deps.store, apiKeyId, amountCents, calls)
  } catch {
    // Store failed during minting: fail closed, same as above.
    return {
      kind: 'response',
      response: NextResponse.json(
        { error: 'challenge_store_unavailable', code: 'C402_STORE_UNAVAILABLE', recoverable: true },
        { status: 503, headers: { [C402_HEADERS.retryAfter]: '5', 'Cache-Control': 'no-store' } },
      ),
    }
  }

  const paymentUrl = buildCheckoutUrl({
    publicKey: deps.wompiPublicKey,
    amountCents,
    reference: buildChallengeReference(challenge.nonce),
    redirectUrl: deps.redirectUrl,
  })

  const payload = buildChallengePayload(challenge, paymentUrl, {
    statusUrl: deps.statusUrl ? deps.statusUrl.replace('{nonce}', challenge.nonce) : undefined,
  })

  return {
    kind: 'response',
    response: NextResponse.json(build402Body(payload, 'Has excedido tu limite gratuito. Paga por mas llamadas API.'), {
      status: 402,
      headers: {
        [C402_HEADERS.challenge]: encodeChallengeHeader(payload),
        'Cache-Control': 'no-store',
      },
    }),
  }
}

/**
 * Optional helper for endpoints that accept a client retry carrying
 * X-402-Payment-Id. The challenge must belong to the caller and be settled.
 */
export function readPaymentId(req: NextRequest): string | null {
  return req.headers.get(C402_HEADERS.paymentId)
}
