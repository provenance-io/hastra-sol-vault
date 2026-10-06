//! Negative cases for every instruction of both programs, driven by the IDL account list. Each
//! mutation changes one account of the authorized call and must be rejected by the check that
//! guards it (see `rejected_by`); the unmodified call must then succeed on the same world.
//!
//! - signer: the signer flag is cleared, or the key is replaced by a random funded caller;
//! - mint account: replaced by an identical mint at another address;
//! - token account: its owner, or its mint, is rewritten in place (same address, same balance).

use hastra_fuzz::world::*;
use trident_fuzz::fuzzing::*;

/// Substitutions accepted by design: (program, instruction, account, mutation, reason).
const ACCEPTED: &[(Program, &str, &str, Mutation, &str)] = &[
    (
        Program::Mint,
        "initialize",
        "mint",
        Mutation::OtherMint,
        "records the mint, which has the program's authorities",
    ),
    (
        Program::Stake,
        "initialize",
        "mint",
        Mutation::OtherMint,
        "records the mint, which has the program's authorities",
    ),
    (
        Program::Mint,
        "initialize",
        "vault_token_account",
        Mutation::TokenAccountOwner,
        "records the treasury vault owner",
    ),
    (
        Program::Mint,
        "update_vault_token_account",
        "vault_token_account",
        Mutation::TokenAccountOwner,
        "repoints the treasury vault",
    ),
    (
        Program::Mint,
        "freeze_token_account",
        "token_account",
        Mutation::TokenAccountOwner,
        "freezes any holder",
    ),
    (
        Program::Mint,
        "thaw_token_account",
        "token_account",
        Mutation::TokenAccountOwner,
        "thaws any holder",
    ),
    (
        Program::Stake,
        "freeze_token_account",
        "token_account",
        Mutation::TokenAccountOwner,
        "freezes any holder",
    ),
    (
        Program::Stake,
        "thaw_token_account",
        "token_account",
        Mutation::TokenAccountOwner,
        "thaws any holder",
    ),
    (
        Program::Mint,
        "external_program_mint",
        "destination",
        Mutation::TokenAccountOwner,
        "the caller picks the recipient",
    ),
];

/// Errors that show the mutated account was caught by the check guarding it, rather than by an
/// unrelated failure further on.
fn rejected_by(mutation: Mutation) -> &'static [&'static str] {
    match mutation {
        Mutation::Unsigned => &["AccountNotSigner", "ConstraintSigner"],
        Mutation::RandomSigner => &[
            // PDA seeded by the signer (redemption request, external mint authority).
            "ConstraintSeeds",
            "InvalidAuthority",
            "InvalidRewardsAdministrator",
            "InvalidTokenOwner",
            "InvalidUpgradeAuthority",
            "UnauthorizedFreezeAdministrator",
        ],
        Mutation::TokenAccountOwner => &[
            "InvalidAuthority",
            "InvalidTokenOwner",
            "InvalidVaultAuthority",
        ],
        Mutation::TokenAccountMint => &["InvalidMint", "InvalidVaultMint"],
        // `ConstraintRaw`: complete_redeem pins the mint to the redemption request.
        Mutation::OtherMint => &["ConstraintRaw", "InvalidMint", "InvalidVaultMint"],
    }
}

/// Anchor framework errors that `rejected_by` refers to.
const ANCHOR_ERRORS: &[(u32, &str)] = &[
    (2002, "ConstraintSigner"),
    (2003, "ConstraintRaw"),
    (2006, "ConstraintSeeds"),
    (3010, "AccountNotSigner"),
];

fn error_name(program: Program, code: u32) -> String {
    ANCHOR_ERRORS
        .iter()
        .find(|(c, _)| *c == code)
        .map(|(_, n)| *n)
        .or_else(|| program.idl().error_name(code))
        .map_or_else(|| code.to_string(), str::to_string)
}

const TOKEN_ACCOUNT_LEN: usize = 165;
const MINT_LEN: usize = 82;
const TOKEN_ACCOUNT_MINT: std::ops::Range<usize> = 0..32;
const TOKEN_ACCOUNT_OWNER: std::ops::Range<usize> = 32..64;

#[derive(Clone, Copy, Debug, PartialEq)]
enum Mutation {
    Unsigned,
    RandomSigner,
    OtherMint,
    TokenAccountOwner,
    TokenAccountMint,
}

struct Case {
    mutation: Mutation,
    account: &'static str,
    instruction: Instruction,
    /// Account rewritten in place, restored before the control call.
    restore: Option<(Pubkey, AccountSharedData)>,
}

/// A fresh world in which `name`'s authorized call is valid.
fn prepare(trident: &mut Trident, program: Program, name: &str) -> World {
    if program.setup().contains(&name) {
        let world = World::new(trident, 1);
        world.setup(trident, Some((program, name)));
        return world;
    }
    let world = World::ready(trident, 1);
    let pre = |name: &str| world.call(program, name).instruction();
    match (program, name) {
        (Program::Mint, "cancel_redeem") => {
            ok(trident, pre("request_redeem"), "pre: request_redeem")
        }
        (Program::Mint, "complete_redeem") => {
            ok(trident, pre("request_redeem"), "pre: request_redeem");
            world.mint_usdc(trident, world.redeem_vault, 1_000_000);
        }
        (Program::Mint, "sweep_redeem_vault_funds") => {
            world.mint_usdc(trident, world.redeem_vault, 1_000_000)
        }
        (Program::Mint, "claim_rewards") => ok(
            trident,
            pre("create_rewards_epoch"),
            "pre: create_rewards_epoch",
        ),
        (_, "thaw_token_account") => ok(
            trident,
            pre("freeze_token_account"),
            "pre: freeze_token_account",
        ),
        (Program::Stake, "apply_verified_report_for_testing") => {
            trident.warp_to_timestamp(START_TIME + 1)
        }
        _ => {}
    }
    world
}

fn cases(trident: &mut Trident, world: &World, call: &Call) -> Vec<Case> {
    let base = call.instruction();
    let mints = [world.usdc_mint, world.wylds_mint, world.prime_mint];
    let mut out = Vec::new();
    let mut push = |mutation, account, instruction, restore| {
        out.push(Case {
            mutation,
            account,
            instruction,
            restore,
        })
    };
    for (i, account) in call
        .program
        .idl()
        .instruction(call.name)
        .accounts
        .iter()
        .enumerate()
    {
        let name: &'static str = &account.name;
        let key = base.accounts[i].pubkey;
        let replaced = |key: Pubkey| {
            let mut ix = base.clone();
            ix.accounts[i].pubkey = key;
            ix
        };
        if account.signer {
            let mut unsigned = base.clone();
            unsigned.accounts[i].is_signer = false;
            push(Mutation::Unsigned, name, unsigned, None);
            let caller = trident.random_pubkey();
            trident.airdrop(&caller, 10 * LAMPORTS_PER_SOL);
            push(Mutation::RandomSigner, name, replaced(caller), None);
        }
        let original = trident.get_account(&key);
        if original.owner() != &TOKEN_PROGRAM {
            continue;
        }
        match original.data().len() {
            MINT_LEN => {
                let decoy = trident.random_pubkey();
                trident.set_account_custom(&decoy, &original);
                push(Mutation::OtherMint, name, replaced(decoy), None);
            }
            TOKEN_ACCOUNT_LEN => {
                let mint = Pubkey::try_from(&original.data()[TOKEN_ACCOUNT_MINT]).unwrap();
                let other_mint = *mints.iter().find(|m| **m != mint).unwrap();
                for (mutation, field, value) in [
                    (
                        Mutation::TokenAccountOwner,
                        TOKEN_ACCOUNT_OWNER,
                        trident.random_pubkey(),
                    ),
                    (Mutation::TokenAccountMint, TOKEN_ACCOUNT_MINT, other_mint),
                ] {
                    let mut patched = original.clone();
                    patched.data_as_mut_slice()[field].copy_from_slice(value.as_ref());
                    push(mutation, name, base.clone(), Some((key, patched)));
                }
            }
            _ => {}
        }
    }
    out
}

fn caught(program: Program, mutation: Mutation, code: Option<u32>) -> bool {
    code.is_some_and(|code| rejected_by(mutation).contains(&error_name(program, code).as_str()))
}

fn accepted(program: Program, ix: &str, account: &str, mutation: Mutation) -> bool {
    ACCEPTED
        .iter()
        .any(|(p, i, a, m, _)| (*p, *i, *a, *m) == (program, ix, account, mutation))
}

#[test]
fn every_instruction_rejects_wrong_accounts_and_signers() {
    let mut problems = Vec::new();
    let mut total = 0;
    for program in [Program::Mint, Program::Stake] {
        for ix in &program.idl().instructions {
            let name = ix.name.as_str();
            if name == "verify_price" {
                continue;
            }
            let count = {
                let mut trident = Trident::default();
                let world = prepare(&mut trident, program, name);
                cases(&mut trident, &world, &world.call(program, name)).len()
            };
            if count == 0 {
                problems.push(format!(
                    "{program:?}::{name}: no account or signer to mutate"
                ));
            }
            // A fresh world per case, so an accepted substitution cannot mask the next case, and
            // each rejection is paired with the authorized call succeeding on that same world.
            for case in 0..count {
                total += 1;
                let mut trident = Trident::default();
                let world = prepare(&mut trident, program, name);
                let call = world.call(program, name);
                let Case {
                    mutation,
                    account,
                    instruction,
                    restore,
                } = cases(&mut trident, &world, &call).swap_remove(case);
                let tag = format!("{program:?}::{name}: {mutation:?} {account}");
                let original = restore.as_ref().map(|(key, patched)| {
                    let original = trident.get_account(key);
                    trident.set_account_custom(key, patched);
                    (*key, original)
                });
                let result = trident.process_transaction(&[instruction], None);
                if let Some((key, original)) = original {
                    trident.set_account_custom(&key, &original);
                }
                let by_design = accepted(program, name, account, mutation);
                if result.is_success() {
                    if !by_design {
                        problems.push(format!("{tag} was accepted"));
                    }
                    continue;
                }
                if by_design {
                    problems.push(format!("{tag} is listed in ACCEPTED but was rejected"));
                } else if !caught(program, mutation, result.get_custom_error_code()) {
                    problems.push(format!(
                        "{tag} rejected by an unrelated check: {:?}",
                        result.get_result()
                    ));
                }
                let control = trident.process_transaction(&[call.instruction()], None);
                if !control.is_success() {
                    problems.push(format!(
                        "{tag}: authorized control failed: {}",
                        control.logs()
                    ));
                }
            }
        }
    }
    assert!(
        problems.is_empty(),
        "{total} cases\n{}",
        problems.join("\n")
    );
}

/// The Chainlink verifier is not deployed in TridentSVM, so `verify_price` has no succeeding
/// control; it must still reject a missing or foreign signer before reaching the CPI.
#[test]
fn verify_price_rejects_foreign_and_missing_signer() {
    let mut trident = Trident::default();
    let world = World::ready(&mut trident, 1);
    let call = world.call(Program::Stake, "verify_price");
    for case in cases(&mut trident, &world, &call) {
        let result = trident.process_transaction(&[case.instruction], None);
        let expected = match case.mutation {
            Mutation::Unsigned => "AccountNotSigner",
            Mutation::RandomSigner => "InvalidRewardsAdministrator",
            other => panic!("unexpected {other:?} on {}", case.account),
        };
        let code = result
            .get_custom_error_code()
            .expect("rejected with a custom error");
        assert_eq!(
            error_name(Program::Stake, code),
            expected,
            "{:?} {}",
            case.mutation,
            case.account
        );
    }
}
