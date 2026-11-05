/**
 * Next.js route handler for Wompi webhooks (App Router).
 *
 * Path: app/api/payments/webhook/wompi/route.ts
 *
 * Every branch answers 200 to well-formed events, including duplicates, because
 * the provider retries on non-2xx. Verification happens before any grant:
 *   signature -> normalise -> settleAndGrant (which re-checks amount/currency and
 *   performs the atomic claim).
 */
import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
// Package imports: these files are copied into an app that depends on c402-protocol.
import {
  settleAndGrant,
  StoreCreditLedger,
  parseWompiEvent,
  verifyEventChecksum,
  WOMPI_CHECKSUM_HEADER,
} from 'c402-protocol'
import type { ChallengeStore } from 'c402-protocol'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

export interface WebhookDeps {
  store: ChallengeStore
  eventsSecret: string
}

export function createWompiWebhookHandler(deps: WebhookDeps) {
  return async function POST(req: NextRequest): Promise<NextResponse> {
    const rawBody = await req.text()
    const checksum = req.headers.get(WOMPI_CHECKSUM_HEADER)

    if (!verifyEventChecksum(rawBody, checksum, deps.eventsSecret)) {
      return NextResponse.json({ error: 'Invalid checksum' }, { status: 401 })
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(rawBody)
    } catch {
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
    }

    const event = parseWompiEvent(parsed as never)
    if (!event) return NextResponse.json({ error: 'Malformed event' }, { status: 400 })

    // Not a c402 challenge: hand off to your own order/payment flow.
    if (!event.reference.startsWith('c402_')) {
      return NextResponse.json({ received: true, ignored: 'not_a_challenge' })
    }

    const result = await settleAndGrant({
      store: deps.store,
      ledger: new StoreCreditLedger(deps.store),
      event,
    })

    if (result.ok) {
      return NextResponse.json({ received: true, creditsAdded: result.granted })
    }

    switch (result.reason) {
      case 'already_settled':
      case 'claim_lost':
        // Duplicate delivery: must be 200 or the provider keeps retrying.
        return NextResponse.json({ received: true, alreadyProcessed: true })
      case 'amount_mismatch':
      case 'currency_mismatch':
        // Do not 5xx: a mismatch is terminal, not transient.
        console.error(`[c402] settlement rejected for ${event.reference}: ${result.reason}`)
        return NextResponse.json({ error: 'Payment mismatch', reason: result.reason }, { status: 409 })
      case 'invalid_status':
        return NextResponse.json({ received: true, ignored: 'status_not_settleable' })
      case 'invalid_challenge':
        // Corrupt stored record: retrying will not repair it.
        console.error(`[c402] settlement rejected for ${event.reference}: invalid stored challenge`)
        return NextResponse.json({ received: true, ignored: 'invalid_challenge' })
      case 'expired_beyond_grace':
        console.error(`[c402] settlement rejected for ${event.reference}: expired beyond grace`)
        return NextResponse.json({ error: 'Challenge expired' }, { status: 410 })
      case 'store_unavailable':
      case 'grant_failed':
        // The buyer paid and we could not grant. 503 so the provider retries:
        // a 200 here would silently drop the payment. grant_failed has already
        // released the claim, so the retry can succeed.
        console.error(`[c402] settlement deferred for ${event.reference}: ${result.reason}`)
        return NextResponse.json(
          { error: 'Settlement deferred', reason: result.reason, recoverable: true },
          { status: 503, headers: { 'Retry-After': '30', 'Cache-Control': 'no-store' } },
        )
      case 'unknown_challenge':
      default:
        return NextResponse.json({ received: true, deferred: true })
    }
  }
}
