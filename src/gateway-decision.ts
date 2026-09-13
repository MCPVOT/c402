/**
 * Pure access decision, extracted so it is testable without any web framework.
 *
 * c402 requires FAIL CLOSED: when the challenge store is unreachable and the
 * caller has no prepaid credits, the request is refused (503) rather than
 * served for free. Serving it would let a store outage become free traffic.
 */
export type AccessDecision =
  | { action: 'allow'; remainingCredits: number }
  | { action: 'pay'; reason: 'no_credits' }
  | { action: 'unavailable'; reason: 'store_unavailable' }

export interface DecideAccessInput {
  creditsRemaining: number
  storeAvailable: boolean
  failClosed: boolean
}

export function decideAccess(input: DecideAccessInput): AccessDecision {
  if (input.creditsRemaining > 0) {
    return { action: 'allow', remainingCredits: input.creditsRemaining }
  }
  if (!input.storeAvailable && input.failClosed) {
    return { action: 'unavailable', reason: 'store_unavailable' }
  }
  return { action: 'pay', reason: 'no_credits' }
}
