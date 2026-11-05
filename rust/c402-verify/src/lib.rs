//! Offline verification of c402 payment receipts.
//!
//! This crate is the Rust counterpart of `src/receipt.ts`. Both sides build the
//! same line-oriented canonical string and HMAC it with SHA-256, so a receipt
//! signed by a TypeScript issuer verifies here without calling the issuer.
//!
//! The canonical form is deliberately not JSON: JSON has several equally valid
//! encodings (key order, whitespace, number formatting), and a signature that
//! disagrees between two languages because of serialisation is worse than no
//! signature at all.
//!
//! ```text
//! c402-receipt-v1
//! nonce=<nonce>
//! keyHash=<sha256(apiKeyId) hex>
//! amountCents=<integer minor units>
//! currency=<ISO 4217, upper case>
//! calls=<integer>
//! transactionId=<provider id>
//! paidAt=<RFC 3339>
//! expiresAt=<RFC 3339>
//! ```
//!
//! No trailing newline. Any change to this list or its separators is a new
//! version tag in both languages.

use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};

/// The only receipt format this crate verifies.
pub const RECEIPT_VERSION: &str = "c402-receipt-v1";

type HmacSha256 = Hmac<Sha256>;

/// The signed fields of a receipt. `sig` and `v` are not part of this struct
/// because they are not part of the signing input.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReceiptPayload {
    pub nonce: String,
    pub key_hash: String,
    pub amount_cents: i64,
    pub currency: String,
    pub calls: i64,
    pub transaction_id: String,
    pub paid_at: String,
    pub expires_at: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VerifyError {
    /// The signature did not match the canonical input.
    BadSignature,
    /// The signature was not 32 bytes of hex.
    MalformedSignature,
    /// A field failed a shape check (empty, non-positive amount, etc).
    MalformedReceipt,
}

impl std::fmt::Display for VerifyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            VerifyError::BadSignature => write!(f, "receipt signature does not match"),
            VerifyError::MalformedSignature => write!(f, "receipt signature is not 64 hex characters"),
            VerifyError::MalformedReceipt => write!(f, "receipt fields are malformed"),
        }
    }
}

impl std::error::Error for VerifyError {}

/// sha256 hex of an API key id, the only key material a receipt carries.
pub fn hash_api_key(api_key_id: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(api_key_id.as_bytes());
    hex_encode(&hasher.finalize())
}

/// The exact bytes a receipt signature covers.
pub fn signing_input(p: &ReceiptPayload) -> String {
    format!(
        "{}\nnonce={}\nkeyHash={}\namountCents={}\ncurrency={}\ncalls={}\ntransactionId={}\npaidAt={}\nexpiresAt={}",
        RECEIPT_VERSION,
        p.nonce,
        p.key_hash,
        p.amount_cents,
        p.currency.to_uppercase(),
        p.calls,
        p.transaction_id,
        p.paid_at,
        p.expires_at,
    )
}

/// Lowercase hex HMAC-SHA256 of the canonical signing input.
pub fn sign(payload: &ReceiptPayload, secret: &[u8]) -> String {
    let mut mac = HmacSha256::new_from_slice(secret).expect("HMAC accepts keys of any length");
    mac.update(signing_input(payload).as_bytes());
    hex_encode(&mac.finalize().into_bytes())
}

/// Verify a receipt signature. Constant-time on the MAC comparison.
pub fn verify(payload: &ReceiptPayload, signature_hex: &str, secret: &[u8]) -> Result<(), VerifyError> {
    if payload.nonce.is_empty()
        || payload.key_hash.len() != 64
        || payload.amount_cents <= 0
        || payload.currency.is_empty()
        || payload.calls <= 0
        || payload.transaction_id.is_empty()
        || payload.paid_at.is_empty()
        || payload.expires_at.is_empty()
    {
        return Err(VerifyError::MalformedReceipt);
    }
    verify_canonical(&signing_input(payload), signature_hex, secret)
}

/// Verify a signature over an already-built canonical string.
///
/// This is the entry point for receipts that arrive as bytes (a file, a header,
/// a log line): rebuild nothing, verify exactly what the issuer signed.
pub fn verify_canonical(input: &str, signature_hex: &str, secret: &[u8]) -> Result<(), VerifyError> {
    let signature = hex_decode(signature_hex).ok_or(VerifyError::MalformedSignature)?;
    if signature.len() != 32 {
        return Err(VerifyError::MalformedSignature);
    }

    let mut mac = HmacSha256::new_from_slice(secret).expect("HMAC accepts keys of any length");
    mac.update(input.as_bytes());
    mac.verify_slice(&signature)
        .map_err(|_| VerifyError::BadSignature)
}

fn hex_encode(bytes: &[u8]) -> String {
    const TABLE: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(TABLE[(byte >> 4) as usize] as char);
        out.push(TABLE[(byte & 0x0f) as usize] as char);
    }
    out
}

fn hex_decode(input: &str) -> Option<Vec<u8>> {
    let bytes = input.as_bytes();
    if bytes.len() % 2 != 0 {
        return None;
    }
    let mut out = Vec::with_capacity(bytes.len() / 2);
    for chunk in bytes.chunks(2) {
        let hi = hex_nibble(chunk[0])?;
        let lo = hex_nibble(chunk[1])?;
        out.push((hi << 4) | lo);
    }
    Some(out)
}

fn hex_nibble(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn canonical_input_is_line_oriented() {
        let input = signing_input(&vector());
        assert!(input.starts_with("c402-receipt-v1\n"));
        assert!(input.ends_with("expiresAt=2026-08-24T21:30:00.000Z"));
    }

    #[test]
    fn hashes_api_keys() {
        assert_eq!(hash_api_key("key-1"), vector().key_hash);
    }
}
