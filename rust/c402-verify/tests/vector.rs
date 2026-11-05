//! Cross-language vector. The same bytes are asserted in `tests/receipt.test.ts`.
//! A change to the canonical form on either side fails both suites.

use c402_verify::{
    hash_api_key, normalize_receipt_text, sign, signing_input, verify, verify_receipt_text,
    ReceiptPayload, VerifyError,
};

const SECRET: &[u8] = b"test-secret-0123456789";
const EXPECTED_SIG: &str = "35c7221a55287b72eef382b4b439f24af400c5e5c531c4c4a925032627e44d14";

fn vector() -> ReceiptPayload {
    ReceiptPayload {
        nonce: "b3f1c9e2-9a4d-4f61-8b3a-9f1e0d7c2a55".into(),
        key_hash: "be2974546978e3739e6d6da85c4be9f334ce32df2b9fd4b6ff1b55c0d57e9d44".into(),
        amount_cents: 250_000,
        currency: "COP".into(),
        calls: 50,
        transaction_id: "tx-001".into(),
        paid_at: "2026-08-24T21:00:00.000Z".into(),
        expires_at: "2026-08-24T21:30:00.000Z".into(),
    }
}

#[test]
fn signing_input_matches_the_typescript_vector() {
    assert_eq!(
        signing_input(&vector()),
        concat!(
            "c402-receipt-v1\n",
            "nonce=b3f1c9e2-9a4d-4f61-8b3a-9f1e0d7c2a55\n",
            "keyHash=be2974546978e3739e6d6da85c4be9f334ce32df2b9fd4b6ff1b55c0d57e9d44\n",
            "amountCents=250000\n",
            "currency=COP\n",
            "calls=50\n",
            "transactionId=tx-001\n",
            "paidAt=2026-08-24T21:00:00.000Z\n",
            "expiresAt=2026-08-24T21:30:00.000Z",
        )
    );
}

#[test]
fn produces_the_shared_signature() {
    assert_eq!(sign(&vector(), SECRET), EXPECTED_SIG);
}

#[test]
fn verifies_a_receipt_signed_by_typescript() {
    assert_eq!(verify(&vector(), EXPECTED_SIG, SECRET), Ok(()));
}

#[test]
fn rejects_a_tampered_amount() {
    let mut tampered = vector();
    tampered.amount_cents = 1;
    assert_eq!(verify(&tampered, EXPECTED_SIG, SECRET), Err(VerifyError::BadSignature));
}

#[test]
fn rejects_a_tampered_transaction_id() {
    let mut tampered = vector();
    tampered.transaction_id = "tx-002".into();
    assert_eq!(verify(&tampered, EXPECTED_SIG, SECRET), Err(VerifyError::BadSignature));
}

#[test]
fn rejects_the_wrong_secret() {
    assert_eq!(verify(&vector(), EXPECTED_SIG, b"another-secret"), Err(VerifyError::BadSignature));
}

#[test]
fn rejects_a_malformed_signature() {
    assert_eq!(verify(&vector(), "zz", SECRET), Err(VerifyError::MalformedSignature));
    assert_eq!(verify(&vector(), "", SECRET), Err(VerifyError::MalformedSignature));
    assert_eq!(verify(&vector(), "abcd", SECRET), Err(VerifyError::MalformedSignature));
}

#[test]
fn rejects_malformed_fields() {
    let mut empty_nonce = vector();
    empty_nonce.nonce = String::new();
    assert_eq!(verify(&empty_nonce, EXPECTED_SIG, SECRET), Err(VerifyError::MalformedReceipt));

    let mut zero_calls = vector();
    zero_calls.calls = 0;
    assert_eq!(verify(&zero_calls, EXPECTED_SIG, SECRET), Err(VerifyError::MalformedReceipt));
}

#[test]
fn currency_is_case_insensitive_in_the_signing_input() {
    let mut lower = vector();
    lower.currency = "cop".into();
    assert_eq!(signing_input(&lower), signing_input(&vector()));
    assert_eq!(verify(&lower, EXPECTED_SIG, SECRET), Ok(()));
}

#[test]
fn hashes_api_keys_like_typescript() {
    assert_eq!(hash_api_key("key-1"), vector().key_hash);
    assert_ne!(hash_api_key("key-2"), vector().key_hash);
}

// Cross-platform: a receipt written on Windows must verify unchanged.

fn text_with(eol: &str) -> String {
    format!(
        "{}{}sig={}{}",
        signing_input(&vector()).replace('\n', eol),
        eol,
        EXPECTED_SIG,
        eol
    )
}

#[test]
fn verifies_lf_receipt_text() {
    assert_eq!(verify_receipt_text(&text_with("\n"), SECRET), Ok(()));
}

#[test]
fn verifies_crlf_receipt_text() {
    assert_eq!(verify_receipt_text(&text_with("\r\n"), SECRET), Ok(()));
}

#[test]
fn verifies_receipt_text_with_a_utf8_bom() {
    let text = format!("\u{feff}{}", text_with("\r\n"));
    assert_eq!(verify_receipt_text(&text, SECRET), Ok(()));
}

#[test]
fn rejects_tampered_crlf_receipt_text() {
    let text = text_with("\r\n").replace("amountCents=250000", "amountCents=1");
    assert_eq!(verify_receipt_text(&text, SECRET), Err(VerifyError::BadSignature));
}

#[test]
fn normalises_line_endings_and_bom() {
    assert_eq!(normalize_receipt_text("\u{feff}a\r\nb\rc\n\n"), "a\nb\nc");
}
