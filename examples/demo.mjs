#!/usr/bin/env node
/**
 * c402 end-to-end demo. No network, no provider account, no API key.
 *
 * Runs the whole protocol once: challenge -> 402 payload -> settlement ->
 * credits -> signed receipt -> offline verification -> tamper rejection.
 *
 *   npm run build && node examples/demo.mjs
 */
import {
  MemoryStore,
  StoreCreditLedger,
  createChallenge,
  settleAndGrant,
  signReceipt,
  verifyReceiptText,
  receiptSigningInput,
  buildChallengePayload,
  describePaymentStatus,
  buildDiscoveryDocument,
} from '../dist/index.js'

const RECEIPT_SECRET = 'demo-secret-never-use-this-in-production'
const API_KEY = 'demo-key'
const line = (label, value) => console.log(`${label.padEnd(14)} ${value}`)

const store = new MemoryStore()
const ledger = new StoreCreditLedger(store)

// 1. The caller has no credits, so the server mints a challenge.
const challenge = await createChallenge(store, API_KEY, 250_000, 50)
const payload = buildChallengePayload(
  challenge,
  `https://checkout.wompi.co/p/?reference=c402_${challenge.nonce}`,
  { statusUrl: `/c402/status/${challenge.nonce}` },
)
line('challenge', `${challenge.nonce}`)
line('price', `${payload.amountCents} centavos = COP ${payload.amountCents / 100}`)
line('calls', String(payload.calls))
line('expires', payload.expiresAt)
line('status now', describePaymentStatus(challenge).status)

// 2. The provider reports the payment. This is the settlement path.
const event = {
  reference: `c402_${challenge.nonce}`,
  status: 'APPROVED',
  amountInCents: 250_000,
  currency: 'COP',
  transactionId: 'tx-demo-1',
}
const settled = await settleAndGrant({ store, ledger, event })
line('settle', settled.ok ? `ok, granted ${settled.granted} calls` : `rejected: ${settled.reason}`)
line('balance', String(await ledger.balance(API_KEY)))

// 3. Replaying the same webhook must not grant twice.
const replay = await settleAndGrant({ store, ledger, event })
line('replay', replay.ok ? 'GRANTED AGAIN (bug)' : `refused: ${replay.reason}`)

// 4. A second webhook over the same reference cannot grant either.
const replay2 = await settleAndGrant({ store, ledger, event: { ...event, transactionId: 'tx-demo-2' } })
line('second tx', replay2.ok ? 'GRANTED AGAIN (bug)' : `refused: ${replay2.reason}`)

// 5. A wrong amount is refused and leaves that challenge unclaimed. Use a
//    fresh challenge: the first one is already settled, and its replay
//    refusal would hide the amount check.
const second = await createChallenge(store, API_KEY, 250_000, 50)
const secondEvent = {
  reference: `c402_${second.nonce}`,
  status: 'APPROVED',
  amountInCents: 250_000,
  currency: 'COP',
  transactionId: 'tx-demo-3',
}
const wrong = await settleAndGrant({
  store, ledger,
  event: { ...secondEvent, transactionId: 'tx-demo-underpay', amountInCents: 99_999 },
})
line('underpay', wrong.ok ? 'GRANTED (bug)' : `refused: ${wrong.reason}`)
const correct = await settleAndGrant({ store, ledger, event: secondEvent })
line('paid exact', correct.ok ? `ok, granted ${correct.granted} calls` : `rejected: ${correct.reason}`)
line('new balance', String(await ledger.balance(API_KEY)))

// 6. The issuer signs a receipt; it verifies offline and BROKEN when tampered.
const receipt = signReceipt(settled.challenge, event, RECEIPT_SECRET)
const text = receiptSigningInput({
  nonce: receipt.nonce,
  keyHash: receipt.keyHash,
  amountCents: receipt.amountCents,
  currency: receipt.currency,
  calls: receipt.calls,
  transactionId: receipt.transactionId,
  paidAt: receipt.paidAt,
  expiresAt: receipt.expiresAt,
}) + `\nsig=${receipt.sig}`

line('receipt sig', receipt.sig.slice(0, 16) + '…')
line('verify', JSON.stringify(verifyReceiptText(text, RECEIPT_SECRET)))
line('tampered', JSON.stringify(verifyReceiptText(text.replace('amountCents=250000', 'amountCents=1'), RECEIPT_SECRET)))

const discovery = buildDiscoveryDocument({ receipt: { supported: true } })
line('discovery', `${discovery.protocol} ${discovery.version}, rails: ${discovery.rails.join(', ')}`)
line('final status', describePaymentStatus(await store.get(challenge.nonce)).status)
