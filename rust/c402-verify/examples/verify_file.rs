//! Verify a receipt produced by the TypeScript issuer, from a plain text file.
//!
//! File format: the canonical signing input (see the crate docs), then one line
//! `sig=<64 hex chars>`. CRLF and a UTF-8 BOM are accepted, so a receipt written
//! on Windows verifies here unchanged.
//!
//! Usage:
//!   cargo run --example verify_file -- receipt.txt <secret>
//!   C402_RECEIPT_SECRET=... cargo run --example verify_file -- receipt.txt

use std::env;
use std::fs;
use std::process::ExitCode;

fn main() -> ExitCode {
    let mut args = env::args().skip(1);
    let path = match args.next() {
        Some(p) => p,
        None => {
            eprintln!("usage: verify_file <receipt.txt> [secret]");
            return ExitCode::from(2);
        }
    };

    let secret = match args.next().or_else(|| env::var("C402_RECEIPT_SECRET").ok()) {
        Some(s) => s,
        None => {
            eprintln!("no secret: pass it as the second argument or set C402_RECEIPT_SECRET");
            return ExitCode::from(2);
        }
    };

    let body = match fs::read_to_string(&path) {
        Ok(b) => b,
        Err(e) => {
            eprintln!("cannot read {path}: {e}");
            return ExitCode::from(2);
        }
    };

    match c402_verify::verify_receipt_text(&body, secret.as_bytes()) {
        Ok(()) => {
            println!("VALID");
            ExitCode::SUCCESS
        }
        Err(e) => {
            println!("INVALID: {e}");
            ExitCode::FAILURE
        }
    }
}
