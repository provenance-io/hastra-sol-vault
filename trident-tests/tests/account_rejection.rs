//! Negative cases for every instruction of both programs, driven by the IDL account list: each
//! signer is unsigned and replaced by a random caller, each mint is replaced by an identical mint
//! at another address, and each token account by an identical account with another owner. Every
//! mutation must fail, and the unmodified authorized call must then succeed on the same world.

use hastra_fuzz::world::*;
use trident_fuzz::fuzzing::*;

/// Substitutions accepted by design: (program, instruction, account, reason).
const ACCEPTED: &[(Program, &str, &str, &str)] = &[
    (
        Program::Mint,
        "initialize",
        "mint",
        "records the mint; the decoy has the program's authorities",
    ),
    (
        Program::Mint,
        "initialize",
        "vault_token_account",
        "records the treasury vault and its owner",
    ),
    (
        Program::Stake,
        "initialize",
        "mint",
        "records the mint; the decoy has the program's authorities",
    ),
    (
        Program::Mint,
        "update_vault_token_account",
        "vault_token_account",
        "repoints the treasury vault",
    ),
    (
        Program::Mint,
        "freeze_token_account",
        "token_account",
        "freezes any holder of the mint",
    ),
    (
        Program::Mint,
        "thaw_token_account",
        "token_account",
        "thaws any holder of the mint",
    ),
    (
        Program::Stake,
        "freeze_token_account",
        "token_account",
        "freezes any holder of the mint",
    ),
    (
        Program::Stake,
        "thaw_token_account",
        "token_account",
        "thaws any holder of the mint",
    ),
    (
        Program::Mint,
        "external_program_mint",
        "destination",
        "the allow-listed caller picks the recipient",
    ),
];

const TOKEN_ACCOUNT_LEN: usize = 165;
const MINT_LEN: usize = 82;
const TOKEN_ACCOUNT_OWNER: std::ops::Range<usize> = 32..64;

#[derive(Debug)]
enum Mutation {
    Unsigned,
    RandomSigner,
    OtherMint,
    OtherOwner,
}

/// A fresh world in which `name`'s authorized call is valid.
fn prepare(trident: &mut Trident, program: Program, name: &str) -> World {
    let setup = match program {
        Program::Mint => MINT_SETUP,
        Program::Stake => STAKE_SETUP,
    };
    if setup.contains(&name) {
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

fn mutations(trident: &mut Trident, call: &Call) -> Vec<(Mutation, &'static str, Instruction)> {
    let idl = call.program.idl();
    let base = call.instruction();
    let mut out = Vec::new();
    for (i, account) in idl.instruction(call.name).accounts.iter().enumerate() {
        let name: &'static str = &account.name;
        let key = base.accounts[i].pubkey;
        if account.signer {
            let mut unsigned = base.clone();
            unsigned.accounts[i].is_signer = false;
            out.push((Mutation::Unsigned, name, unsigned));
            let caller = trident.random_pubkey();
            trident.airdrop(&caller, 10 * LAMPORTS_PER_SOL);
            out.push((
                Mutation::RandomSigner,
                name,
                with_account(call, name, caller),
            ));
        }
        let original = trident.get_account(&key);
        if original.owner() != &TOKEN_PROGRAM {
            continue;
        }
        let decoy = trident.random_pubkey();
        let mut copy = original.clone();
        let mutation = match original.data().len() {
            MINT_LEN => Mutation::OtherMint,
            TOKEN_ACCOUNT_LEN => {
                copy.data_as_mut_slice()[TOKEN_ACCOUNT_OWNER]
                    .copy_from_slice(trident.random_pubkey().as_ref());
                Mutation::OtherOwner
            }
            _ => continue,
        };
        trident.set_account_custom(&decoy, &copy);
        out.push((mutation, name, with_account(call, name, decoy)));
    }
    out
}

fn with_account(call: &Call, name: &'static str, key: Pubkey) -> Instruction {
    let mut accounts = call.accounts.clone();
    match accounts.iter_mut().find(|(n, _)| *n == name) {
        Some(slot) => slot.1 = key,
        None => accounts.push((name, key)),
    }
    call.program
        .idl()
        .build(call.name, &accounts, call.args.clone())
}

fn accepted(program: Program, ix: &str, account: &str) -> bool {
    ACCEPTED
        .iter()
        .any(|(p, i, a, _)| *p == program && *i == ix && *a == account)
}

#[test]
fn every_instruction_rejects_wrong_accounts_and_signers() {
    let mut problems = Vec::new();
    for program in [Program::Mint, Program::Stake] {
        for ix in &program.idl().instructions {
            let name = ix.name.as_str();
            if name == "verify_price" {
                continue;
            }
            let count = {
                let mut trident = Trident::default();
                let world = prepare(&mut trident, program, name);
                mutations(&mut trident, &world.call(program, name)).len()
            };
            if count == 0 {
                problems.push(format!(
                    "{program:?}::{name}: no account or signer to mutate"
                ));
            }
            // A fresh world per case, so an accepted substitution cannot mask the next case, and
            // each rejection is paired with the authorized call succeeding on that same world.
            for case in 0..count {
                let mut trident = Trident::default();
                let world = prepare(&mut trident, program, name);
                let call = world.call(program, name);
                let (mutation, account, instruction) =
                    mutations(&mut trident, &call).swap_remove(case);
                let tag = format!("{program:?}::{name}: {mutation:?} {account}");
                let result = trident.process_transaction(&[instruction], None);
                match (result.is_success(), accepted(program, name, account)) {
                    (true, true) => continue,
                    (true, false) => problems.push(format!("{tag} was accepted")),
                    (false, true) => {
                        problems.push(format!("{tag} is listed in ACCEPTED but was rejected"))
                    }
                    (false, false) => {}
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
    assert!(problems.is_empty(), "\n{}", problems.join("\n"));
}

/// The Chainlink verifier is not deployed in TridentSVM, so `verify_price` has no succeeding
/// control; it must still reject a missing or foreign signer before reaching the CPI.
#[test]
fn verify_price_rejects_foreign_and_missing_signer() {
    let mut trident = Trident::default();
    let world = World::ready(&mut trident, 1);
    let call = world.call(Program::Stake, "verify_price");
    let idl = Program::Stake.idl();
    for (mutation, account, instruction) in mutations(&mut trident, &call) {
        let code = trident
            .process_transaction(&[instruction], None)
            .get_custom_error_code();
        let expected = match mutation {
            Mutation::Unsigned => 3010, // anchor AccountNotSigner
            Mutation::RandomSigner => idl.error("InvalidRewardsAdministrator"),
            other => panic!("unexpected {other:?} on {account}"),
        };
        assert_eq!(code, Some(expected), "{mutation:?} {account}");
    }
}
