//! Coverage gate for `fuzz_vault`: every IDL instruction has a flow, and the flows reach every
//! listed outcome. The static test runs with the other tests; the metrics test reads the
//! `metrics.json` that `run_fuzz.sh` writes and runs after the fast profile in CI:
//! `FUZZ_METRICS=<out>/metrics.json cargo test --release --test coverage -- --ignored`.
//!
//! An outcome is `ok`, an error name of the instruction's program, `<Program>::<error>` for an
//! error raised by the other program through a CPI, or a decimal code (SPL Token 1 insufficient
//! funds, 13 invalid state, 17 frozen; system program 0 already in use; Anchor 2007 not
//! executable, 3012 not initialized). Every flow asserts the exact outcome it predicts, so a
//! reached outcome is a predicted one. An instruction whose list has no `ok` must never succeed.

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

/// Outcomes each instruction must reach. `ONE_SHOT` initializers must fail with 0 and nothing
/// else is required of them.
#[rustfmt::skip]
const OUTCOMES: &[(Program, &str, &[&str])] = &[
    (Program::Mint, "deposit", &["ok", "InvalidAmount", "ProtocolPaused", "1", "17", "InvalidVaultAuthority", "InvalidVaultTokenAccount"]),
    (Program::Mint, "request_redeem", &["ok", "0", "ProtocolPaused", "InvalidAmount", "InsufficientBalance", "17"]),
    (Program::Mint, "cancel_redeem", &["ok", "3012", "17"]),
    (Program::Mint, "complete_redeem", &["ok", "3012", "InvalidRedeemVault", "InvalidRewardsAdministrator", "RedemptionAmountMismatch", "InsufficientRedemptionBalance", "InsufficientVaultBalance", "17"]),
    (Program::Mint, "sweep_redeem_vault_funds", &["ok", "InvalidRedeemVault", "InvalidVaultAuthority", "InvalidVaultTokenAccount", "InvalidRewardsAdministrator", "InvalidAmount", "InsufficientRedeemVaultFunds"]),
    (Program::Mint, "create_rewards_epoch", &["ok", "0", "ProtocolPaused", "InvalidAmount", "EpochIndexBelowFirstCapped", "EpochIndexNotContiguous", "EpochCapAboveGlobal"]),
    (Program::Mint, "claim_rewards", &["ok", "0", "ProtocolPaused", "InvalidMerkleProof", "EpochCapExceeded", "17"]),
    (Program::Mint, "external_program_mint", &["ok", "2007", "ExternalMintMustBeCpi", "ProtocolPaused", "InvalidRewardsAdministrator", "InvalidMintProgramCaller", "17"]),
    (Program::Mint, "register_allowed_external_mint_program", &["ok", "2007", "TooManyAllowedExternalMintPrograms"]),
    (Program::Mint, "update_external_mint_programs_limit", &["ok"]),
    (Program::Mint, "pause", &["ok", "UnauthorizedFreezeAdministrator"]),
    (Program::Mint, "freeze_token_account", &["ok", "UnauthorizedFreezeAdministrator", "13"]),
    (Program::Mint, "thaw_token_account", &["ok", "UnauthorizedFreezeAdministrator", "13"]),
    (Program::Mint, "update_freeze_administrators", &["ok", "EmptyAdministrators", "TooManyAdministrators", "DuplicateAdministrators"]),
    (Program::Mint, "update_rewards_administrators", &["ok", "EmptyAdministrators", "TooManyAdministrators", "DuplicateAdministrators"]),
    (Program::Mint, "update_max_epoch_cap", &["ok", "InvalidGlobalCap"]),
    (Program::Mint, "update_last_rewards_epoch", &["ok", "EpochIndexBelowFirstCapped"]),
    (Program::Mint, "update_vault_token_account", &["ok", "InvalidVaultMint"]),
    (Program::Mint, "update_redeem_vault", &["ok", "InvalidVaultMint", "InvalidVaultAuthority"]),
    // SPL overflow (14) of the PRIME supply is predicted but needs a supply near u64::MAX.
    (Program::Stake, "deposit", &["ok", "InvalidAmount", "ProtocolPaused", "PriceNotInitialized", "PriceTooStale", "Overflow", "DepositTooSmall", "1", "17"]),
    (Program::Stake, "redeem", &["ok", "InvalidAmount", "ProtocolPaused", "PriceNotInitialized", "PriceTooStale", "InsufficientBalance", "Overflow", "DivisionByZero", "InsufficientVaultBalance", "17"]),
    (Program::Stake, "publish_rewards", &["ok", "0", "ProtocolPaused", "InvalidRewardsAdministrator", "InvalidAmount", "RewardPublicationIdNotMonotonic", "RewardPublicationIdGapTooLarge", "RewardExceedsMaxDelta", "ExceedsPeriodRewardCap", "RewardCooldownNotElapsed", "ExceedsLifetimeRewardCap", "Mint::ProtocolPaused", "Mint::InvalidRewardsAdministrator"]),
    (Program::Stake, "pause", &["ok", "UnauthorizedFreezeAdministrator"]),
    (Program::Stake, "freeze_token_account", &["ok", "UnauthorizedFreezeAdministrator", "13"]),
    (Program::Stake, "thaw_token_account", &["ok", "UnauthorizedFreezeAdministrator", "13"]),
    (Program::Stake, "update_freeze_administrators", &["ok", "TooManyAdministrators"]),
    (Program::Stake, "update_rewards_administrators", &["ok", "TooManyAdministrators"]),
    (Program::Stake, "apply_verified_report_for_testing", &["ok", "InvalidRewardsAdministrator", "FutureReportValidFromTimestamp", "ReportStale", "InvalidFeedId", "InvalidReportTimestamps", "FutureObservationTimestamp", "ObservationTimestampNotIncreasing"]),
    // Never succeeds: no Chainlink verifier is deployed to CPI into.
    (Program::Stake, "verify_price", &["InvalidRewardsAdministrator", "InvalidAuthority"]),
    (Program::Stake, "update_price_config", &["ok"]),
    (Program::Stake, "shares_to_assets", &["ok", "PriceNotInitialized", "Overflow", "DivisionByZero"]),
    (Program::Stake, "assets_to_shares", &["ok", "PriceNotInitialized", "Overflow"]),
    (Program::Stake, "exchange_rate", &["ok", "PriceNotInitialized", "Overflow", "DivisionByZero"]),
    (Program::Stake, "update_max_reward_bps", &["ok", "InvalidMaxRewardBps"]),
    (Program::Stake, "update_max_period_rewards", &["ok", "InvalidMaxPeriodRewards"]),
    (Program::Stake, "update_reward_period_seconds", &["ok", "InvalidRewardPeriodSeconds"]),
    (Program::Stake, "update_max_total_rewards", &["ok", "InvalidMaxTotalRewards"]),
    (Program::Stake, "update_last_reward_publication", &["ok"]),
];

/// Outcomes required at a labelled boundary case (`<Program>::<instruction> (<case>)`).
const CASES: &[(&str, &str)] = &[
    ("Stake::deposit (at staleness boundary)", "ok"),
    ("Stake::deposit (one second stale)", "PriceTooStale"),
    ("Stake::redeem (at staleness boundary)", "ok"),
    ("Stake::redeem (one second stale)", "PriceTooStale"),
    ("Stake::publish_rewards (cooldown just ended)", "ok"),
    (
        "Stake::publish_rewards (one second before cooldown end)",
        "RewardCooldownNotElapsed",
    ),
    ("Mint::freeze_token_account (already frozen)", "13"),
    ("Mint::thaw_token_account (not frozen)", "13"),
    ("Stake::freeze_token_account (already frozen)", "13"),
    ("Stake::thaw_token_account (not frozen)", "13"),
    ("Stake::update_price_config (invalidates price)", "ok"),
];

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

/// The outcomes required of an instruction, or `None` for a test-only one.
fn required(program: Program, name: &str) -> Option<&'static [&'static str]> {
    if TEST_ONLY
        .iter()
        .any(|(p, n, _)| (*p, *n) == (program, name))
    {
        return None;
    }
    if ONE_SHOT.contains(&(program, name)) {
        return Some(&["0"]);
    }
    OUTCOMES
        .iter()
        .find(|(p, n, _)| (*p, *n) == (program, name))
        .map(|(_, _, outcomes)| *outcomes)
}

/// The metrics key of `outcome` for an instruction of `program`: `ok` or an error code.
fn outcome_key(program: Program, outcome: &str) -> String {
    if outcome == "ok" || outcome.parse::<u32>().is_ok() {
        return outcome.to_string();
    }
    let (program, name) = match outcome.split_once("::") {
        Some(("Mint", name)) => (Program::Mint, name),
        Some(("Stake", name)) => (Program::Stake, name),
        Some(_) => panic!("{outcome}: unknown program"),
        None => (program, outcome),
    };
    program.idl().error(name).to_string()
}

fn program_of(label: &str) -> Program {
    match label.split("::").next() {
        Some("Mint") => Program::Mint,
        Some("Stake") => Program::Stake,
        _ => panic!("{label}: no program"),
    }
}

#[test]
fn every_instruction_has_required_outcomes() {
    let mut problems = Vec::new();
    for (program, name) in instructions() {
        let listed = [
            TEST_ONLY
                .iter()
                .any(|(p, n, _)| (*p, *n) == (program, name)),
            ONE_SHOT.contains(&(program, name)),
            OUTCOMES.iter().any(|(p, n, _)| (*p, *n) == (program, name)),
        ];
        if listed.iter().filter(|l| **l).count() != 1 {
            problems.push(format!(
                "{program:?}::{name} must be in exactly one of TEST_ONLY, ONE_SHOT and OUTCOMES"
            ));
        }
    }
    let known = |program, name: &str| instructions().any(|i| i == (program, name));
    let named = TEST_ONLY.iter().map(|(p, n, _)| (*p, *n));
    for (program, name) in named.chain(OUTCOMES.iter().map(|(p, n, _)| (*p, *n))) {
        if !known(program, name) {
            problems.push(format!("{program:?}::{name} is not in the IDL"));
        }
    }
    // Resolving every outcome panics on an unknown error name.
    for (program, _, outcomes) in OUTCOMES {
        outcomes.iter().for_each(|o| drop(outcome_key(*program, o)));
    }
    for (label, outcome) in CASES {
        outcome_key(program_of(label), outcome);
    }
    assert!(problems.is_empty(), "{}", problems.join("\n"));
}

/// Per label: `ok` -> successes, error code -> occurrences.
type Counts = HashMap<String, HashMap<String, u64>>;

fn read_metrics(path: &str) -> Counts {
    let metrics: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(path).expect("read FUZZ_METRICS"))
            .expect("metrics.json is JSON");
    let mut counts = Counts::new();
    for (label, entry) in metrics["transactions"].as_object().expect("transactions") {
        let outcomes = counts.entry(label.clone()).or_default();
        outcomes.insert(
            "ok".into(),
            entry["transaction_successful"].as_u64().unwrap_or(0),
        );
        if let Some(errors) = entry["custom_instruction_errors"]["errors"].as_object() {
            for (code, error) in errors {
                outcomes.insert(code.clone(), error["occurrences"].as_u64().unwrap_or(0));
            }
        }
    }
    counts
}

#[test]
#[ignore = "needs FUZZ_METRICS from a fuzz run"]
fn fuzz_run_reaches_every_required_outcome() {
    let path = std::env::var("FUZZ_METRICS").expect("FUZZ_METRICS=<path to metrics.json>");
    let counts = read_metrics(&path);
    // Labels are `<Program>::<instruction>`, optionally followed by ` (<case>)`.
    let mut by_instruction: Counts = Counts::new();
    for (label, outcomes) in &counts {
        let total = by_instruction
            .entry(label.split(" (").next().unwrap().to_string())
            .or_default();
        for (outcome, n) in outcomes {
            *total.entry(outcome.clone()).or_default() += n;
        }
    }
    let reached = |counts: &Counts, label: &str, key: &str| {
        counts
            .get(label)
            .and_then(|o| o.get(key))
            .is_some_and(|n| *n > 0)
    };
    let mut problems = Vec::new();
    for (program, name) in instructions() {
        let Some(outcomes) = required(program, name) else {
            continue;
        };
        let label = format!("{program:?}::{name}");
        for outcome in outcomes {
            if !reached(&by_instruction, &label, &outcome_key(program, outcome)) {
                problems.push(format!("{label} never reached {outcome}"));
            }
        }
        if !outcomes.contains(&"ok") && reached(&by_instruction, &label, "ok") {
            problems.push(format!("{label} succeeded, but its outcomes have no ok"));
        }
    }
    for (label, outcome) in CASES {
        if !reached(&counts, label, &outcome_key(program_of(label), outcome)) {
            problems.push(format!("{label} never reached {outcome}"));
        }
    }
    assert!(problems.is_empty(), "{path}:\n{}", problems.join("\n"));
}
