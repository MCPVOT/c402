//! Verify a receipt produced by the TypeScript issuer, from a plain text file.
//!
//! File format: the canonical signing input (see the crate docs), then one line
//! `sig=<64 hex chars>`. This is what `c402-receipt.txt` looks like when an
//! issuer hands a receipt to an agent that has no HTTP client.
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

    let trimmed = body.trim_end_matches('\n');
    let (input, sig) = match trimmed.rsplit_once('\n') {
        Some((input, last)) => match last.strip_prefix("sig=") {
            Some(sig) => (input, sig),
            None => {
                eprintln!("last line must be sig=<hex>");
                return ExitCode::from(2);
            }
        },
        None => {
            eprintln!("receipt file is too short");
            return ExitCode::from(2);
        }
    };

    match c402_verify::verify_canonical(input, sig, secret.as_bytes()) {
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
