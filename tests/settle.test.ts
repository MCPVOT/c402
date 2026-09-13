import { describe, expect, it } from 'vitest'
import { settleAndGrant } from '../src/challenge.js'
import { createChallenge } from '../src/challenge.js'
import { StoreCreditLedger } from '../src/ledger.js'
import { MemoryStore } from '../src/stores/memory.js'
import type { SettlementEvent } from '../src/types.js'

function setup() {
  const store = new MemoryStore()
  const ledger = new StoreCreditLedger(store)
  return { store, ledger }
}

async function makeChallenge(store: MemoryStore, ledger: StoreCreditLedger, amountCents = 2500) {
  const c = await createChallenge(store, 'key-1', amountCents, 50)
  const event: SettlementEvent = {
    reference: `c402_${c.nonce}`,
    status: 'APPROVED',
    amountInCents: amountCents,
    currency: 'COP',
    transactionId: 'tx-1',
  }
  return { challenge: c, event }
}

describe('settleAndGrant', () => {
  it('grants credits once and marks the challenge paid', async () => {
    const { store, ledger } = setup()
    const { challenge, event } = await makeChallenge(store, ledger)

    const res = await settleAndGrant({ store, ledger, event })
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.granted).toBe(50)

    expect(await ledger.balance('key-1')).toBe(50)
    const after = await store.get(challenge.nonce)
    expect(after?.paid).toBe(true)
    expect(after?.settledTransactionId).toBe('tx-1')
  })

  it('is idempotent when the same webhook arrives twice in sequence', async () => {
    const { store, ledger } = setup()
    const { event } = await makeChallenge(store, ledger)

    const first = await settleAndGrant({ store, ledger, event })
    const second = await settleAndGrant({ store, ledger, event })

    expect(first.ok).toBe(true)
    expect(second.ok).toBe(false)
    if (!second.ok) expect(second.reason).toBe('already_settled')
    expect(await ledger.balance('key-1')).toBe(50)
  })

  it('grants exactly once when concurrent webhooks race (no double grant)', async () => {
    const { store, ledger } = setup()
    const { event } = await makeChallenge(store, ledger)

    const results = await Promise.all(
      Array.from({ length: 10 }, () => settleAndGrant({ store, ledger, event })),
    )
    const grants = results.filter((r) => r.ok)
    expect(grants).toHaveLength(1)
    expect(await ledger.balance('key-1')).toBe(50)
    expect(results.filter((r) => !r.ok && r.reason === 'claim_lost')).toHaveLength(9)
  })

  it('rejects an unknown nonce', async () => {
    const { store, ledger } = setup()
    const res = await settleAndGrant({
      store,
      ledger,
      event: { reference: 'c402_missing', status: 'APPROVED', amountInCents: 2500, currency: 'COP', transactionId: 'tx' },
    })
    expect(res).toEqual({ ok: false, reason: 'unknown_challenge', challenge: null })
  })

  it('does not claim or grant when the amount is wrong', async () => {
    const { store, ledger } = setup()
    const { challenge, event } = await makeChallenge(store, ledger)

    const res = await settleAndGrant({ store, ledger, event: { ...event, amountInCents: 1 } })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe('amount_mismatch')

    // the nonce must still be claimable, and no credits granted
    expect(await ledger.balance('key-1')).toBe(0)
    const still = await store.get(challenge.nonce)
    expect(still?.paid).toBe(false)

    const retry = await settleAndGrant({ store, ledger, event })
    expect(retry.ok).toBe(true)
    expect(await ledger.balance('key-1')).toBe(50)
  })

  it('ignores a reference that is not a c402 challenge', async () => {
    const { store, ledger } = setup()
    const res = await settleAndGrant({
      store,
      ledger,
      event: { reference: 'some-other-order', status: 'APPROVED', amountInCents: 2500, currency: 'COP', transactionId: 'tx' },
    })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe('unknown_challenge')
  })

  it('does not grant twice if the provider reuses a reference for a second transaction', async () => {
    const { store, ledger } = setup()
    const { event } = await makeChallenge(store, ledger)

    await settleAndGrant({ store, ledger, event })
    const replay = await settleAndGrant({ store, ledger, event: { ...event, transactionId: 'tx-2' } })
    expect(replay.ok).toBe(false)
    if (!replay.ok) expect(replay.reason).toBe('already_settled')
    expect(await ledger.balance('key-1')).toBe(50)
  })
})
