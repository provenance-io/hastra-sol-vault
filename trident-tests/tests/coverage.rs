//! Coverage gate for `fuzz_vault`: every IDL instruction has a flow, and every flow reaches its
//! success path. The static test runs with the other tests; the metrics test reads the
//! `metrics.json` that `run_fuzz.sh` writes and runs after the fast profile in CI:
//! `FUZZ_METRICS=<out>/metrics.json cargo test --release --test coverage -- --ignored`.

use hastra_fuzz::world::*;
use std::collections::HashMap;

/// Test-only instructions; they have no flow of their own.
const TEST_ONLY: &[(Program, &str, &str)] = &[
    (
        Program::Mint,
        "cpi_invoke_for_testing",
        "relays another instruction; metrics count the relayed one",
    ),
    (
        Program::Stake,
        "cpi_invoke_for_testing",
        "relays another instruction; metrics count the relayed one",
    ),
    (
        Program::Stake,
        "set_price_for_testing",
        "flows set prices through apply_verified_report_for_testing",
    ),
];

/// Instructions whose flow can only fail; the gate requires that they are invoked and never
/// succeed.
const NO_SUCCESS: &[(Program, &str, &str)] = &[
    (
        Program::Mint,
        "initialize",
        "one-shot, succeeds only in setup",
    ),
    (
        Program::Mint,
        "initialize_epoch_caps",
        "one-shot, succeeds only in setup",
    ),
    (
        Program::Mint,
        "initialize_last_rewards_epoch",
        "one-shot, succeeds only in setup",
    ),
    (
        Program::Stake,
        "initialize",
        "one-shot, succeeds only in setup",
    ),
    (
        Program::Stake,
        "initialize_price_config",
        "one-shot, succeeds only in setup",
    ),
    (
        Program::Stake,
        "initialize_stake_reward_config",
        "one-shot, succeeds only in setup",
    ),
    (
        Program::Stake,
        "initialize_last_reward_publication",
        "one-shot, succeeds only in setup",
    ),
    (
        Program::Stake,
        "verify_price",
        "no Chainlink verifier is deployed to CPI into",
    ),
];

const FUZZ_SOURCE: &str = include_str!("../fuzz_vault/test_fuzz.rs");

fn listed(table: &[(Program, &str, &str)], program: Program, name: &str) -> bool {
    table.iter().any(|(p, n, _)| (*p, *n) == (program, name))
}

fn instructions() -> impl Iterator<Item = (Program, &'static str)> {
    [Program::Mint, Program::Stake]
        .into_iter()
        .flat_map(|program| {
            program
                .idl()
                .instructions
                .iter()
                .map(move |ix| (program, ix.name.as_str()))
        })
}

#[test]
fn every_instruction_has_a_flow() {
    let mut problems = Vec::new();
    for (program, name) in instructions() {
        if !listed(TEST_ONLY, program, name) && !FUZZ_SOURCE.contains(&format!("\"{name}\"")) {
            problems.push(format!("{program:?}::{name} has no fuzz flow"));
        }
    }
    for (table, label) in [(TEST_ONLY, "TEST_ONLY"), (NO_SUCCESS, "NO_SUCCESS")] {
        for (program, name, _) in table {
            if !instructions().any(|i| i == (*program, *name)) {
                problems.push(format!("{program:?}::{name} in {label} is not in the IDL"));
            }
        }
    }
    assert!(problems.is_empty(), "{}", problems.join("\n"));
}

#[test]
#[ignore = "needs FUZZ_METRICS from a fuzz run"]
fn every_flow_reaches_its_success_path() {
    let path = std::env::var("FUZZ_METRICS").expect("FUZZ_METRICS=<path to metrics.json>");
    let metrics: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&path).expect("read FUZZ_METRICS"))
            .expect("metrics.json is JSON");
    // Labels are `<Program>::<instruction>`, optionally followed by ` (<case>)`.
    let mut counts: HashMap<&str, (u64, u64)> = HashMap::new();
    for (label, entry) in metrics["transactions"].as_object().expect("transactions") {
        let count = |key: &str| entry[key].as_u64().unwrap_or(0);
        let total = counts.entry(label.split(" (").next().unwrap()).or_default();
        total.0 += count("transaction_invoked");
        total.1 += count("transaction_successful");
    }
    let mut problems = Vec::new();
    for (program, name) in instructions() {
        if listed(TEST_ONLY, program, name) {
            continue;
        }
        let key = format!("{program:?}::{name}");
        let (invoked, successful) = counts.get(key.as_str()).copied().unwrap_or_default();
        if invoked == 0 {
            problems.push(format!("{key} was never invoked"));
        } else if listed(NO_SUCCESS, program, name) {
            if successful > 0 {
                problems.push(format!("{key} succeeded but is listed in NO_SUCCESS"));
            }
        } else if successful == 0 {
            problems.push(format!("{key} never succeeded in {invoked} calls"));
        }
    }
    assert!(problems.is_empty(), "{path}:\n{}", problems.join("\n"));
}
