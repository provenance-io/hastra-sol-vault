//! A deployed vault-mint + vault-stake (pool-prime) system inside TridentSVM, plus the authorized
//! call for every instruction of both programs.

use std::sync::OnceLock;

use trident_fuzz::fuzzing::solana_sdk::hash::hashv;
use trident_fuzz::fuzzing::*;

use crate::idl::Idl;

pub const UPGRADE_AUTHORITY: Pubkey = pubkey!("UpgradeAuthority111111111111111111111111111");
pub const FREEZE_ADMIN: Pubkey = pubkey!("FreezeAdmin11111111111111111111111111111111");
pub const REWARDS_ADMIN: Pubkey = pubkey!("RewardsAdmin1111111111111111111111111111111");
/// Any executable account works as an allow-list candidate; this one is preloaded by TridentSVM.
pub const SOME_EXECUTABLE: Pubkey = pubkey!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
pub const TOKEN_PROGRAM: Pubkey = pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

pub const FIRST_CAPPED_EPOCH: u64 = 5;
pub const MAX_EPOCH_CAP: u64 = 1_000_000_000_000;
pub const MAX_EXTERNAL_PROGRAMS: u8 = 3;
pub const PRICE_SCALE: u64 = 1_000_000_000;
pub const PRICE_MAX_STALENESS: i64 = 3_600;
pub const FEED_ID: [u8; 32] = [7; 32];
pub const START_TIME: i64 = 1_750_000_000;
pub const USER_USDC: u64 = 1_000_000_000_000;
pub const USER_STAKE_DEPOSIT: u64 = 100_000_000_000;
pub const CLAIM_AMOUNT: u64 = 5_000_000;

pub fn mint_idl() -> &'static Idl {
    static IDL: OnceLock<Idl> = OnceLock::new();
    IDL.get_or_init(|| Idl::load("vault_mint.json"))
}

pub fn stake_idl() -> &'static Idl {
    static IDL: OnceLock<Idl> = OnceLock::new();
    IDL.get_or_init(|| Idl::load("vault_stake.json"))
}

pub fn mint_id() -> Pubkey {
    mint_idl().program_id
}

pub fn stake_id() -> Pubkey {
    stake_idl().program_id
}

pub fn pda(seeds: &[&[u8]], program: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(seeds, program).0
}

pub fn program_data(program: &Pubkey) -> Pubkey {
    pda(&[program.as_ref()], &solana_sdk::bpf_loader_upgradeable::ID)
}

pub fn args<T: BorshSerialize>(value: &T) -> Vec<u8> {
    borsh::to_vec(value).unwrap()
}

/// Merkle leaf used by `claim_rewards`: sha256(user || amount_le || epoch_le).
pub fn claim_leaf(user: &Pubkey, amount: u64, epoch: u64) -> [u8; 32] {
    hashv(&[&[user.as_ref(), &amount.to_le_bytes(), &epoch.to_le_bytes()].concat()]).to_bytes()
}

/// Merkle tree over `leaves`, matching the on-chain verifier: `is_left` marks a left sibling and
/// an odd node is promoted with a zero sibling (hashed alone).
pub struct MerkleTree {
    levels: Vec<Vec<[u8; 32]>>,
}

/// One proof element, Borsh-compatible with `ProofNode { sibling, is_left }`.
pub type ProofNode = ([u8; 32], bool);

impl MerkleTree {
    pub fn new(leaves: Vec<[u8; 32]>) -> Self {
        assert!(!leaves.is_empty());
        let mut levels = vec![leaves];
        while levels.last().unwrap().len() > 1 {
            let next = levels
                .last()
                .unwrap()
                .chunks(2)
                .map(|pair| match pair {
                    [l, r] => hashv(&[l, r]).to_bytes(),
                    [only] => hashv(&[only]).to_bytes(),
                    _ => unreachable!(),
                })
                .collect();
            levels.push(next);
        }
        Self { levels }
    }

    pub fn root(&self) -> [u8; 32] {
        self.levels.last().unwrap()[0]
    }

    pub fn proof(&self, mut index: usize) -> Vec<ProofNode> {
        let mut proof = Vec::new();
        for level in &self.levels[..self.levels.len() - 1] {
            let sibling = index ^ 1;
            proof.push(match level.get(sibling) {
                Some(node) => (*node, sibling < index),
                None => ([0; 32], false),
            });
            index /= 2;
        }
        proof
    }
}

/// ABI-encodes a Chainlink ReportDataV7 for `apply_verified_report_for_testing`.
pub fn report_v7(
    feed_id: [u8; 32],
    valid_from: u32,
    observations: u32,
    expires_at: u32,
    rate: i128,
) -> Vec<u8> {
    let word_u32 = |v: u32| {
        let mut w = [0u8; 32];
        w[28..].copy_from_slice(&v.to_be_bytes());
        w
    };
    let mut rate_word = if rate < 0 { [0xff; 32] } else { [0; 32] };
    rate_word[16..].copy_from_slice(&rate.to_be_bytes());
    [
        feed_id,
        word_u32(valid_from),
        word_u32(observations),
        [0; 32],
        [0; 32],
        word_u32(expires_at),
        rate_word,
    ]
    .concat()
}

pub fn ok(trident: &mut Trident, ix: Instruction, label: &str) {
    let result = trident.process_transaction(&[ix], Some(label));
    assert!(result.is_success(), "{label} failed: {}", result.logs());
}

pub fn token_balance(trident: &mut Trident, account: Pubkey) -> u64 {
    trident
        .get_token_account(account)
        .map(|a| a.account.amount)
        .unwrap_or(0)
}

pub fn mint_supply(trident: &mut Trident, mint: Pubkey) -> u64 {
    trident.get_mint(mint).unwrap().mint.supply
}

pub struct User {
    pub key: Pubkey,
    pub usdc: Pubkey,
    pub wylds: Pubkey,
    pub prime: Pubkey,
}

pub struct World {
    pub usdc_mint: Pubkey,
    pub usdc_authority: Pubkey,
    pub wylds_mint: Pubkey,
    pub prime_mint: Pubkey,
    /// Owner of the vault-mint deposit vault (`config.vault_authority`).
    pub treasury: Pubkey,
    pub mint_vault: Pubkey,
    pub redeem_vault: Pubkey,
    pub stake_vault: Pubkey,
    pub users: Vec<User>,
}

/// Instruction names in the order `World::setup` runs them; an instruction's world is built by
/// running every step before it.
pub const MINT_SETUP: &[&str] = &[
    "initialize",
    "initialize_epoch_caps",
    "initialize_last_rewards_epoch",
    "update_external_mint_programs_limit",
];
pub const STAKE_SETUP: &[&str] = &[
    "initialize",
    "initialize_price_config",
    "initialize_stake_reward_config",
    "initialize_last_reward_publication",
];

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Program {
    Mint,
    Stake,
}

impl Program {
    pub fn idl(self) -> &'static Idl {
        match self {
            Program::Mint => mint_idl(),
            Program::Stake => stake_idl(),
        }
    }
}

/// A call with the authorized signer and valid accounts. `accounts` lists only what the IDL
/// cannot derive.
pub struct Call {
    pub program: Program,
    pub name: &'static str,
    pub accounts: Vec<(&'static str, Pubkey)>,
    pub args: Vec<u8>,
}

impl Call {
    pub fn instruction(&self) -> Instruction {
        self.program
            .idl()
            .build(self.name, &self.accounts, self.args.clone())
    }

    /// The address this call resolves for account `name`.
    pub fn account(&self, name: &str) -> Pubkey {
        let accounts = &self.program.idl().instruction(self.name).accounts;
        let i = accounts
            .iter()
            .position(|a| a.name == name)
            .unwrap_or_else(|| panic!("{}: no account {name}", self.name));
        self.instruction().accounts[i].pubkey
    }

    pub fn with(mut self, name: &'static str, key: Pubkey) -> Self {
        match self.accounts.iter_mut().find(|(n, _)| *n == name) {
            Some(slot) => slot.1 = key,
            None => self.accounts.push((name, key)),
        }
        self
    }
}

impl World {
    /// Creates mints and token accounts; no vault instruction has run yet.
    pub fn new(trident: &mut Trident, users: usize) -> Self {
        trident.warp_to_timestamp(START_TIME);
        for key in [UPGRADE_AUTHORITY, FREEZE_ADMIN, REWARDS_ADMIN] {
            trident.airdrop(&key, 100 * LAMPORTS_PER_SOL);
        }

        let usdc_authority = trident.random_pubkey();
        let usdc_mint = new_mint(trident, &usdc_authority, None);
        let wylds_mint = new_mint(
            trident,
            &pda(&[b"mint_authority"], &mint_id()),
            Some(&pda(&[b"freeze_authority"], &mint_id())),
        );
        let prime_mint = new_mint(
            trident,
            &pda(&[b"mint_authority"], &stake_id()),
            Some(&pda(&[b"freeze_authority"], &stake_id())),
        );

        let treasury = trident.random_pubkey();
        let mint_vault = new_token_account(trident, &usdc_mint, &treasury);
        let redeem_vault = new_token_account(trident, &usdc_mint, &UPGRADE_AUTHORITY);
        let stake_vault = new_token_account(trident, &wylds_mint, &UPGRADE_AUTHORITY);

        let users = (0..users)
            .map(|_| {
                let key = trident.random_pubkey();
                trident.airdrop(&key, 10 * LAMPORTS_PER_SOL);
                User {
                    key,
                    usdc: new_token_account(trident, &usdc_mint, &key),
                    wylds: new_token_account(trident, &wylds_mint, &key),
                    prime: new_token_account(trident, &prime_mint, &key),
                }
            })
            .collect();

        Self {
            usdc_mint,
            usdc_authority,
            wylds_mint,
            prime_mint,
            treasury,
            mint_vault,
            redeem_vault,
            stake_vault,
            users,
        }
    }

    /// Runs the setup steps of both programs (stopping before `stop_before`, if given), then
    /// funds every user with USDC, wYLDS and PRIME.
    pub fn setup(&self, trident: &mut Trident, stop_before: Option<(Program, &str)>) {
        for (program, steps) in [(Program::Mint, MINT_SETUP), (Program::Stake, STAKE_SETUP)] {
            for step in steps {
                if stop_before == Some((program, *step)) {
                    return;
                }
                let call = self.call(program, step);
                ok(
                    trident,
                    call.instruction(),
                    &format!("setup {program:?}::{step}"),
                );
            }
        }
        // TridentSVM adds elapsed wall-clock time to the Clock after every transaction.
        trident.warp_to_timestamp(START_TIME);
        self.publish_price(trident, PRICE_SCALE as i128);
        for i in 0..self.users.len() {
            self.fund_user(trident, i);
        }
    }

    pub fn ready(trident: &mut Trident, users: usize) -> Self {
        let world = Self::new(trident, users);
        world.setup(trident, None);
        world
    }

    pub fn mint_usdc(&self, trident: &mut Trident, to: Pubkey, amount: u64) {
        let ix = trident.mint_to(&to, &self.usdc_mint, &self.usdc_authority, amount);
        ok(trident, ix, "mint usdc");
    }

    /// Half of the user's USDC -> wYLDS through vault-mint, then part of it -> PRIME through
    /// vault-stake.
    pub fn fund_user(&self, trident: &mut Trident, i: usize) {
        let usdc = self.users[i].usdc;
        self.mint_usdc(trident, usdc, USER_USDC);
        let deposit = self.mint_call_for("deposit", i).with_args(&(USER_USDC / 2));
        ok(trident, deposit.instruction(), "fund: vault-mint deposit");
        let stake = self
            .stake_call_for("deposit", i)
            .with_args(&USER_STAKE_DEPOSIT);
        ok(trident, stake.instruction(), "fund: vault-stake deposit");
    }

    /// Stores `price` observed now via `apply_verified_report_for_testing`.
    pub fn publish_price(&self, trident: &mut Trident, price: i128) {
        let now = trident.get_current_timestamp() as u32;
        let report = report_v7(FEED_ID, now, now, now + 60, price);
        let ix = self
            .call(Program::Stake, "apply_verified_report_for_testing")
            .with_args(&report)
            .instruction();
        ok(trident, ix, "publish price");
    }

    pub fn call(&self, program: Program, name: &str) -> Call {
        match program {
            Program::Mint => self.mint_call_for(name, 0),
            Program::Stake => self.stake_call_for(name, 0),
        }
    }

    /// Authorized vault-mint call acting for user `u` where a user is involved.
    pub fn mint_call_for(&self, name: &str, u: usize) -> Call {
        let user = &self.users.get(u);
        let user_key = user.map(|u| u.key).unwrap_or_default();
        let user_usdc = user.map(|u| u.usdc).unwrap_or_default();
        let user_wylds = user.map(|u| u.wylds).unwrap_or_default();
        let pd = ("program_data", program_data(&mint_id()));
        let ua = ("signer", UPGRADE_AUTHORITY);
        let epoch = FIRST_CAPPED_EPOCH;
        let (name, accounts, data): (&'static str, Vec<(&'static str, Pubkey)>, Vec<u8>) =
            match name {
                "initialize" => (
                    "initialize",
                    vec![
                        ("vault_token_account", self.mint_vault),
                        ("redeem_vault_token_account", self.redeem_vault),
                        ("vault_token_mint", self.usdc_mint),
                        ("mint", self.wylds_mint),
                        ua,
                        pd,
                        ("allowed_external_mint_program", stake_id()),
                    ],
                    args(&(vec![FREEZE_ADMIN], vec![REWARDS_ADMIN])),
                ),
                "pause" => ("pause", vec![("signer", FREEZE_ADMIN)], args(&true)),
                "deposit" => (
                    "deposit",
                    vec![
                        ("vault_token_account", self.mint_vault),
                        ("mint", self.wylds_mint),
                        ("signer", user_key),
                        ("user_vault_token_account", user_usdc),
                        ("user_mint_token_account", user_wylds),
                    ],
                    args(&1_000_000u64),
                ),
                "request_redeem" => (
                    "request_redeem",
                    vec![
                        ("signer", user_key),
                        ("user_mint_token_account", user_wylds),
                        ("mint", self.wylds_mint),
                    ],
                    args(&1_000_000u64),
                ),
                "cancel_redeem" => (
                    "cancel_redeem",
                    vec![
                        ("signer", user_key),
                        ("user_mint_token_account", user_wylds),
                    ],
                    vec![],
                ),
                "complete_redeem" => (
                    "complete_redeem",
                    vec![
                        ("admin", REWARDS_ADMIN),
                        ("user", user_key),
                        ("user_mint_token_account", user_wylds),
                        ("user_vault_token_account", user_usdc),
                        ("redeem_vault_token_account", self.redeem_vault),
                        ("mint", self.wylds_mint),
                    ],
                    args(&1_000_000u64),
                ),
                "update_freeze_administrators" => (
                    "update_freeze_administrators",
                    vec![pd, ua],
                    args(&vec![FREEZE_ADMIN]),
                ),
                "update_rewards_administrators" => (
                    "update_rewards_administrators",
                    vec![pd, ua],
                    args(&vec![REWARDS_ADMIN]),
                ),
                "freeze_token_account" | "thaw_token_account" => (
                    if name == "freeze_token_account" {
                        "freeze_token_account"
                    } else {
                        "thaw_token_account"
                    },
                    vec![
                        ("token_account", user_wylds),
                        ("mint", self.wylds_mint),
                        ("signer", FREEZE_ADMIN),
                    ],
                    vec![],
                ),
                "create_rewards_epoch" => (
                    "create_rewards_epoch",
                    vec![
                        ("admin", UPGRADE_AUTHORITY),
                        pd,
                        ("epoch", epoch_pda(epoch)),
                        ("epoch_claimed", epoch_claimed_pda(epoch)),
                    ],
                    args(&(
                        epoch,
                        claim_leaf(&user_key, CLAIM_AMOUNT, epoch),
                        CLAIM_AMOUNT,
                    )),
                ),
                "claim_rewards" => (
                    "claim_rewards",
                    vec![
                        ("user", user_key),
                        ("epoch", epoch_pda(epoch)),
                        ("epoch_claimed", epoch_claimed_pda(epoch)),
                        ("mint", self.wylds_mint),
                        ("user_mint_token_account", user_wylds),
                    ],
                    args(&(CLAIM_AMOUNT, Vec::<ProofNode>::new())),
                ),
                "initialize_epoch_caps" => (
                    "initialize_epoch_caps",
                    vec![ua, pd],
                    args(&(FIRST_CAPPED_EPOCH, MAX_EPOCH_CAP)),
                ),
                "initialize_last_rewards_epoch" => (
                    "initialize_last_rewards_epoch",
                    vec![ua, pd],
                    args(&(FIRST_CAPPED_EPOCH - 1)),
                ),
                "update_last_rewards_epoch" => (
                    "update_last_rewards_epoch",
                    vec![ua, pd],
                    args(&FIRST_CAPPED_EPOCH),
                ),
                "update_max_epoch_cap" => (
                    "update_max_epoch_cap",
                    vec![ua, pd],
                    args(&(MAX_EPOCH_CAP / 2)),
                ),
                "external_program_mint" => (
                    "external_program_mint",
                    vec![
                        ("calling_program", stake_id()),
                        ("mint", self.wylds_mint),
                        ("admin", REWARDS_ADMIN),
                        ("destination", user_wylds),
                    ],
                    args(&1_000u64),
                ),
                "register_allowed_external_mint_program" => (
                    "register_allowed_external_mint_program",
                    vec![("external_program", SOME_EXECUTABLE), ua, pd],
                    vec![],
                ),
                "update_external_mint_programs_limit" => (
                    "update_external_mint_programs_limit",
                    vec![ua, pd],
                    args(&MAX_EXTERNAL_PROGRAMS),
                ),
                "update_vault_token_account" => (
                    "update_vault_token_account",
                    vec![("vault_token_account", self.mint_vault), pd, ua],
                    vec![],
                ),
                "update_redeem_vault" => (
                    "update_redeem_vault",
                    vec![("redeem_vault_token_account", self.redeem_vault), pd, ua],
                    vec![],
                ),
                "sweep_redeem_vault_funds" => (
                    "sweep_redeem_vault_funds",
                    vec![
                        ("redeem_vault_token_account", self.redeem_vault),
                        ("vault_token_account", self.mint_vault),
                        ("signer", REWARDS_ADMIN),
                    ],
                    args(&1_000u64),
                ),
                other => panic!("no vault-mint call for {other}"),
            };
        Call {
            program: Program::Mint,
            name,
            accounts,
            args: data,
        }
    }

    /// Authorized vault-stake call acting for user `u` where a user is involved.
    pub fn stake_call_for(&self, name: &str, u: usize) -> Call {
        let user = &self.users.get(u);
        let user_key = user.map(|u| u.key).unwrap_or_default();
        let user_wylds = user.map(|u| u.wylds).unwrap_or_default();
        let user_prime = user.map(|u| u.prime).unwrap_or_default();
        let pd = ("program_data", program_data(&stake_id()));
        let ua = ("signer", UPGRADE_AUTHORITY);
        let price_config_args = args(&(
            Pubkey::new_from_array([1; 32]),
            Pubkey::new_from_array([2; 32]),
            Pubkey::new_from_array([3; 32]),
            FEED_ID,
            PRICE_SCALE,
            PRICE_MAX_STALENESS,
        ));
        let view = vec![
            ("mint", self.prime_mint),
            ("vault_token_account", self.stake_vault),
        ];
        let user_accounts = vec![
            ("vault_token_account", self.stake_vault),
            ("mint", self.prime_mint),
            ("vault_mint", self.wylds_mint),
            ("signer", user_key),
            ("user_vault_token_account", user_wylds),
            ("user_mint_token_account", user_prime),
        ];
        let (name, accounts, data): (&'static str, Vec<(&'static str, Pubkey)>, Vec<u8>) =
            match name {
                "initialize" => (
                    "initialize",
                    vec![
                        ("vault_token_account", self.stake_vault),
                        ("vault_token_mint", self.wylds_mint),
                        ("mint", self.prime_mint),
                        ua,
                        pd,
                    ],
                    args(&(vec![FREEZE_ADMIN], vec![REWARDS_ADMIN])),
                ),
                "pause" => ("pause", vec![("signer", FREEZE_ADMIN)], args(&true)),
                "deposit" => ("deposit", user_accounts, args(&1_000_000u64)),
                "redeem" => ("redeem", user_accounts, args(&1_000_000u64)),
                "update_freeze_administrators" => (
                    "update_freeze_administrators",
                    vec![pd, ua],
                    args(&vec![FREEZE_ADMIN]),
                ),
                "update_rewards_administrators" => (
                    "update_rewards_administrators",
                    vec![pd, ua],
                    args(&vec![REWARDS_ADMIN]),
                ),
                "freeze_token_account" | "thaw_token_account" => (
                    if name == "freeze_token_account" {
                        "freeze_token_account"
                    } else {
                        "thaw_token_account"
                    },
                    vec![
                        ("token_account", user_prime),
                        ("mint", self.prime_mint),
                        ("signer", FREEZE_ADMIN),
                    ],
                    vec![],
                ),
                "publish_rewards" => (
                    "publish_rewards",
                    publish_rewards_accounts(self, 1, 1_000),
                    args(&(1u32, 1_000u64)),
                ),
                "shares_to_assets" => ("shares_to_assets", view, args(&1_000u64)),
                "assets_to_shares" => ("assets_to_shares", view, args(&1_000u64)),
                "exchange_rate" => ("exchange_rate", view, vec![]),
                "initialize_price_config" => {
                    ("initialize_price_config", vec![ua, pd], price_config_args)
                }
                "update_price_config" => ("update_price_config", vec![ua, pd], price_config_args),
                "verify_price" => (
                    "verify_price",
                    vec![
                        (
                            "chainlink_verifier_account",
                            Pubkey::new_from_array([2; 32]),
                        ),
                        (
                            "chainlink_access_controller",
                            Pubkey::new_from_array([3; 32]),
                        ),
                        ("chainlink_config_account", Pubkey::new_from_array([4; 32])),
                        ("chainlink_program", Pubkey::new_from_array([1; 32])),
                        ("signer", REWARDS_ADMIN),
                    ],
                    args(&vec![0u8; 8]),
                ),
                // Setup stores a price observed at START_TIME; this report must be newer.
                "apply_verified_report_for_testing" => {
                    let now = START_TIME as u32 + 1;
                    (
                        "apply_verified_report_for_testing",
                        vec![("signer", REWARDS_ADMIN)],
                        args(&report_v7(FEED_ID, now, now, now + 60, PRICE_SCALE as i128)),
                    )
                }
                "set_price_for_testing" => (
                    "set_price_for_testing",
                    vec![ua, pd],
                    args(&(PRICE_SCALE as i128, START_TIME)),
                ),
                "initialize_stake_reward_config" => {
                    ("initialize_stake_reward_config", vec![ua, pd], vec![])
                }
                "initialize_last_reward_publication" => (
                    "initialize_last_reward_publication",
                    vec![ua, pd],
                    args(&0u32),
                ),
                "update_last_reward_publication" => {
                    ("update_last_reward_publication", vec![ua, pd], args(&10u32))
                }
                "update_max_reward_bps" => ("update_max_reward_bps", vec![ua, pd], args(&100u64)),
                "update_max_period_rewards" => (
                    "update_max_period_rewards",
                    vec![ua, pd],
                    args(&1_000_000u64),
                ),
                "update_reward_period_seconds" => {
                    ("update_reward_period_seconds", vec![ua, pd], args(&60i64))
                }
                "update_max_total_rewards" => (
                    "update_max_total_rewards",
                    vec![ua, pd],
                    args(&1_000_000_000u64),
                ),
                other => panic!("no vault-stake call for {other}"),
            };
        Call {
            program: Program::Stake,
            name,
            accounts,
            args: data,
        }
    }
}

impl Call {
    pub fn with_args<T: BorshSerialize>(mut self, value: &T) -> Self {
        self.args = args(value);
        self
    }
}

pub fn epoch_pda(index: u64) -> Pubkey {
    pda(&[b"epoch", &index.to_le_bytes()], &mint_id())
}

pub fn epoch_claimed_pda(index: u64) -> Pubkey {
    pda(&[b"epoch_claimed", &index.to_le_bytes()], &mint_id())
}

pub fn publish_rewards_accounts(
    world: &World,
    id: u32,
    amount: u64,
) -> Vec<(&'static str, Pubkey)> {
    vec![
        ("mint_program", mint_id()),
        ("this_program", stake_id()),
        ("admin", REWARDS_ADMIN),
        ("rewards_mint", world.wylds_mint),
        ("vault_token_account", world.stake_vault),
        ("mint", world.prime_mint),
        (
            "reward_record",
            pda(
                &[b"reward_record", &id.to_le_bytes(), &amount.to_le_bytes()],
                &stake_id(),
            ),
        ),
    ]
}

pub fn new_mint(trident: &mut Trident, authority: &Pubkey, freeze: Option<&Pubkey>) -> Pubkey {
    let payer = trident.payer().pubkey();
    let mint = trident.random_pubkey();
    let ixs = trident.initialize_mint(&payer, &mint, 6, authority, freeze);
    let result = trident.process_transaction(&ixs, None);
    assert!(result.is_success(), "create mint: {}", result.logs());
    mint
}

pub fn new_token_account(trident: &mut Trident, mint: &Pubkey, owner: &Pubkey) -> Pubkey {
    let payer = trident.payer().pubkey();
    let account = trident.random_pubkey();
    let ixs = trident.initialize_token_account(&payer, &account, mint, owner);
    let result = trident.process_transaction(&ixs, None);
    assert!(
        result.is_success(),
        "create token account: {}",
        result.logs()
    );
    account
}
