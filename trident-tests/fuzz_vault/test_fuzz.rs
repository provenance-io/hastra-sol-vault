//! Stateful fuzzing of vault-mint and vault-stake (pool-prime) against the compiled programs.
//!
//! Each flow predicts the outcome of one instruction from an independent model (success, or the
//! exact error code) and checks the resulting balances. The global invariants run at the start
//! of every flow and in `end`, so they hold after every flow: supply and balance accounting, and
//! every field of both programs' singleton state accounts against the model, so an instruction
//! that writes a field the model does not expect it to fails the run. `end` also checks the
//! per-epoch claim counters. Profiles: `FUZZ_ITERATIONS` x `FUZZ_FLOWS` (defaults below). A
//! failure prints `(seed: <hex>)`; rerun it alone with `TRIDENT_FUZZ_DEBUG=<hex>`.
//!
//! Metrics labels are `<Program>::<instruction>`, optionally followed by ` (<case>)`;
//! `tests/coverage.rs` reads them to check that every instruction reaches its success path and
//! its required error outcomes.

use std::collections::{HashMap, HashSet};

use hastra_fuzz::world::*;
use trident_fuzz::fuzzing::solana_sdk::instruction::InstructionError;
use trident_fuzz::fuzzing::*;

const USERS: usize = 3;
const MAX_GAP: u32 = 255;
const MAX_BPS: u64 = 10_000;
const MAX_ADMINISTRATORS: usize = 5;
const ANCHOR_ACCOUNT_NOT_INITIALIZED: u32 = 3012;
const ANCHOR_CONSTRAINT_EXECUTABLE: u32 = 2007;
/// System program: `init` of an account that already exists.
const ACCOUNT_ALREADY_IN_USE: u32 = 0;
const SPL_INSUFFICIENT_FUNDS: u32 = 1;
/// SPL Token: freezing a frozen account, or thawing one that is not frozen.
const SPL_INVALID_STATE: u32 = 13;
const SPL_OVERFLOW: u32 = 14;
const SPL_ACCOUNT_FROZEN: u32 = 17;
const OTHER_FEED: [u8; 32] = [8; 32];
const OTHER_CHAINLINK: Pubkey = Pubkey::new_from_array([9; 32]);

const EXECUTABLES: [Pubkey; 4] = [
    pubkey!("11111111111111111111111111111111"),
    TOKEN_PROGRAM,
    pubkey!("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"),
    SOME_EXECUTABLE,
];

/// Candidates for every administrator list and administrator signer.
const ADMIN_POOL: [Pubkey; MAX_ADMINISTRATORS] = [
    FREEZE_ADMIN,
    REWARDS_ADMIN,
    Pubkey::new_from_array([0xa1; 32]),
    Pubkey::new_from_array([0xa2; 32]),
    Pubkey::new_from_array([0xa3; 32]),
];

enum Expect {
    Ok,
    Code(u32),
    /// Rejected by the runtime rather than a program.
    Runtime(InstructionError),
}

fn mint_err(name: &str) -> Expect {
    Expect::Code(mint_idl().error(name))
}

fn stake_err(name: &str) -> Expect {
    Expect::Code(stake_idl().error(name))
}

fn err(program: Program, name: &str) -> Expect {
    Expect::Code(program.idl().error(name))
}

/// Runs `ix`, asserts the predicted outcome and returns whether it succeeded, with its logs.
/// `case` is appended to the metrics label.
fn run_result(t: &mut Trident, ix: Instruction, case: &str, expect: Expect) -> (bool, String) {
    let mut label = instruction_label(&ix);
    if !case.is_empty() {
        label = format!("{label} ({case})");
    }
    let result = t.process_transaction(&[ix], Some(&label));
    match expect {
        Expect::Ok => assert!(
            result.is_success(),
            "{label}: expected success\n{}",
            result.logs()
        ),
        Expect::Code(code) => assert_eq!(
            result.get_custom_error_code(),
            Some(code),
            "{label}: expected error {code}, got {:?}\n{}",
            result.get_result(),
            result.logs()
        ),
        Expect::Runtime(error) => assert_eq!(
            result.get_result(),
            &Err(TransactionError::InstructionError(0, error)),
            "{label}\n{}",
            result.logs()
        ),
    }
    (result.is_success(), result.logs())
}

fn run(t: &mut Trident, ix: Instruction, case: &str, expect: Expect) -> bool {
    run_result(t, ix, case, expect).0
}

struct Epoch {
    index: u64,
    total: u64,
    /// `max_epoch_cap` when the epoch was created.
    cap: u64,
    capped: bool,
    tree: MerkleTree,
    leaves: Vec<(usize, u64)>,
    claimed: Vec<bool>,
    claimed_sum: u64,
}

struct RewardConfig {
    bps: u64,
    period_cap: u64,
    period_seconds: i64,
    lifetime_cap: u64,
    distributed: u64,
    last_at: i64,
    last_id: u32,
    /// `(id, amount)` of every publication; each has a record account.
    published: HashSet<(u32, u64)>,
}

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
enum Role {
    Freeze,
    Rewards,
}

impl Role {
    fn update(self) -> &'static str {
        match self {
            Role::Freeze => "update_freeze_administrators",
            Role::Rewards => "update_rewards_administrators",
        }
    }
}

struct Model {
    world: World,
    state: StateAccounts,
    usdc_minted: u64,
    /// wYLDS minted 1:1 against USDC by `deposit` and not yet burned by `complete_redeem`.
    backed: u64,
    /// wYLDS minted without USDC: claims, external program mints and published rewards.
    unbacked: u64,
    /// USDC sent straight to the redeem vault.
    funded: u64,
    /// Current deposit vault and redeem vault of vault-mint.
    vault: Pubkey,
    redeem_vault: Pubkey,
    epochs: Vec<Epoch>,
    last_epoch: u64,
    max_cap: u64,
    unused_uncapped: Vec<u64>,
    pending_redeem: Vec<Option<u64>>,
    allowed: Vec<Pubkey>,
    limit: u8,
    admins: HashMap<(Program, Role), Vec<Pubkey>>,
    paused: HashSet<Program>,
    frozen: HashSet<Pubkey>,
    price: i128,
    price_ts: i64,
    scale: u64,
    staleness: i64,
    feed: [u8; 32],
    /// Fixed at setup; no instruction changes them.
    unbonding_period: i64,
    stake_vault_authority: Pubkey,
    /// Chainlink program, verifier and access controller `verify_price` must be given.
    chainlink: [Pubkey; 3],
    /// Authoritative time; flows pin the SVM clock to it before time-sensitive calls.
    now: i64,
    rewards: RewardConfig,
}

impl Model {
    fn admins(&self, program: Program, role: Role) -> &[Pubkey] {
        &self.admins[&(program, role)]
    }

    fn is_admin(&self, program: Program, role: Role, key: &Pubkey) -> bool {
        self.admins(program, role).contains(key)
    }

    fn paused(&self, program: Program) -> bool {
        self.paused.contains(&program)
    }

    fn frozen(&self, account: Pubkey) -> bool {
        self.frozen.contains(&account)
    }

    fn epoch_exists(&self, index: u64) -> bool {
        self.epochs.iter().any(|e| e.index == index)
    }

    /// Usually the deposit vault; otherwise (`Some(case)`) another USDC account.
    fn pick_mint_vault(&self, t: &mut Trident) -> (Pubkey, Option<&'static str>) {
        let w = &self.world;
        pick_vault(
            t,
            self.vault,
            &[w.mint_vault, w.spare_mint_vault, w.foreign_vault],
        )
    }

    fn pick_redeem_vault(&self, t: &mut Trident) -> (Pubkey, Option<&'static str>) {
        let w = &self.world;
        pick_vault(
            t,
            self.redeem_vault,
            &[w.redeem_vault, w.spare_redeem_vault],
        )
    }

    /// The error a deposit-vault constraint raises for `vault`: its owner is checked against the
    /// current vault's, then its key.
    fn mint_vault_error(&self, t: &mut Trident, vault: Pubkey) -> Option<Expect> {
        if token_owner(t, vault) != token_owner(t, self.vault) {
            Some(mint_err("InvalidVaultAuthority"))
        } else if vault != self.vault {
            Some(mint_err("InvalidVaultTokenAccount"))
        } else {
            None
        }
    }
}

/// `current` seven times in eight, otherwise another of `candidates`, with the case label.
fn pick_vault(
    t: &mut Trident,
    current: Pubkey,
    candidates: &[Pubkey],
) -> (Pubkey, Option<&'static str>) {
    if t.random_from_range(0..8u8) != 0 {
        return (current, None);
    }
    let others: Vec<Pubkey> = candidates
        .iter()
        .copied()
        .filter(|k| *k != current)
        .collect();
    (
        others[t.random_from_range(0..others.len())],
        Some("stale vault"),
    )
}

#[derive(FuzzTestMethods)]
struct FuzzTest {
    trident: Trident,
    fuzz_accounts: Option<Model>,
}

#[flow_executor]
impl FuzzTest {
    fn new() -> Self {
        Self {
            trident: Trident::default(),
            fuzz_accounts: None,
        }
    }

    /// The SVM and model after checking the global invariants on the state the last flow left.
    fn begin(&mut self) -> (&mut Trident, &mut Model) {
        let (t, m) = (&mut self.trident, self.fuzz_accounts.as_mut().unwrap());
        invariants(t, m);
        (t, m)
    }

    #[init]
    fn start(&mut self) {
        let t = &mut self.trident;
        let world = World::ready(t, USERS);
        for program in EXECUTABLES {
            assert!(
                t.get_account(&program).executable(),
                "{program} must be executable"
            );
        }
        // Administrators pay for the accounts they create (e.g. reward records).
        for admin in ADMIN_POOL {
            t.airdrop(&admin, 100 * LAMPORTS_PER_SOL);
        }
        let allowed = allowed_programs(t, &world);
        let admins = [Program::Mint, Program::Stake]
            .into_iter()
            .flat_map(|p| {
                [
                    ((p, Role::Freeze), vec![FREEZE_ADMIN]),
                    ((p, Role::Rewards), vec![REWARDS_ADMIN]),
                ]
            })
            .collect();
        let mut model = Model {
            state: world.state_accounts(),
            unbonding_period: 0,
            stake_vault_authority: Pubkey::default(),
            usdc_minted: USER_USDC * USERS as u64,
            backed: USER_USDC / 2 * USERS as u64,
            unbacked: 0,
            funded: 0,
            vault: world.mint_vault,
            redeem_vault: world.redeem_vault,
            epochs: Vec::new(),
            last_epoch: FIRST_CAPPED_EPOCH - 1,
            max_cap: MAX_EPOCH_CAP,
            unused_uncapped: (0..FIRST_CAPPED_EPOCH).collect(),
            pending_redeem: vec![None; USERS],
            allowed,
            limit: MAX_EXTERNAL_PROGRAMS,
            admins,
            paused: HashSet::new(),
            frozen: HashSet::new(),
            price: PRICE_SCALE as i128,
            price_ts: START_TIME,
            scale: PRICE_SCALE,
            staleness: PRICE_MAX_STALENESS,
            feed: FEED_ID,
            chainlink: [
                CHAINLINK_PROGRAM,
                CHAINLINK_VERIFIER,
                CHAINLINK_ACCESS_CONTROLLER,
            ],
            now: START_TIME,
            rewards: RewardConfig {
                bps: 75,
                period_cap: 1_000_000_000_000,
                period_seconds: 3_540,
                lifetime_cap: 10_000_000_000_000,
                distributed: 0,
                last_at: 0,
                last_id: 0,
                published: HashSet::new(),
            },
            world,
        };
        // Tight random reward caps so the period, cooldown and lifetime limits are all reachable.
        let r = &mut model.rewards;
        r.period_cap = t.random_from_range(1_000_000..=5_000_000_000u64);
        r.lifetime_cap = t.random_from_range(10_000_000..=20_000_000_000u64);
        r.period_seconds = t.random_from_range(1..=600i64);
        let w = &model.world;
        let updates = [
            w.call(Program::Stake, "update_max_period_rewards")
                .with_args(&r.period_cap),
            w.call(Program::Stake, "update_max_total_rewards")
                .with_args(&r.lifetime_cap),
            w.call(Program::Stake, "update_reward_period_seconds")
                .with_args(&r.period_seconds),
        ];
        for update in updates {
            ok(t, update.instruction(), update.name);
        }
        let mut f = Fields::of(t, model.state.stake_config);
        f.skip(64); // vault, mint
        model.unbonding_period = f.i64();
        let mut f = Fields::of(t, model.state.stake_vault_config);
        f.skip(32); // vault_token_account
        model.stake_vault_authority = f.key();
        self.fuzz_accounts = Some(model);
    }

    #[flow]
    fn mint_deposit(&mut self) {
        let (t, m) = self.begin();
        let u = t.random_from_range(0..USERS);
        let user = &m.world.users[u];
        let usdc = token_balance(t, user.usdc);
        let wylds = token_balance(t, user.wylds);
        let amount = pick_amount(t, usdc);
        let (vault, case) = m.pick_mint_vault(t);
        let vault_before = token_balance(t, vault);
        let expect = if let Some(err) = m.mint_vault_error(t, vault) {
            err
        } else if m.paused(Program::Mint) {
            mint_err("ProtocolPaused")
        } else if amount == 0 {
            mint_err("InvalidAmount")
        } else if amount > usdc {
            Expect::Code(SPL_INSUFFICIENT_FUNDS)
        } else if m.frozen(user.wylds) {
            Expect::Code(SPL_ACCOUNT_FROZEN)
        } else {
            Expect::Ok
        };
        let ix = m
            .world
            .mint_call_for("deposit", u)
            .with("vault_token_account", vault)
            .with_args(&amount)
            .instruction();
        if run(t, ix, case.unwrap_or(""), expect) {
            assert_eq!(token_balance(t, user.usdc), usdc - amount);
            assert_eq!(token_balance(t, user.wylds), wylds + amount);
            assert_eq!(token_balance(t, vault), vault_before + amount);
            m.backed += amount;
        }
    }

    #[flow]
    fn create_epoch(&mut self) {
        let (t, m) = self.begin();
        let mut leaves = Vec::new();
        for u in 0..USERS {
            if t.random_bool() {
                leaves.push((u, t.random_from_range(1..=50_000_000u64)));
            }
        }
        if leaves.is_empty() {
            leaves.push((0, t.random_from_range(1..=50_000_000u64)));
        }
        let leaf_sum: u64 = leaves.iter().map(|(_, a)| a).sum();
        // Budgets below the leaf sum make the aggregate cap the binding limit.
        let total = t.random_from_range(1..=leaf_sum + leaf_sum / 2);

        let uncapped = !m.unused_uncapped.is_empty() && t.random_from_range(0..4u8) == 0;
        let index = if uncapped {
            let i = t.random_from_range(0..m.unused_uncapped.len());
            m.unused_uncapped.swap_remove(i)
        } else {
            m.last_epoch + 1
        };
        let tree = MerkleTree::new(
            leaves
                .iter()
                .map(|(u, a)| claim_leaf(&m.world.users[*u].key, *a, index))
                .collect(),
        );

        let total = if uncapped {
            inject_legacy_epoch(t, index, tree.root(), total);
            total
        } else {
            let create = |at: u64, total: u64| {
                let ix = m
                    .world
                    .call(Program::Mint, "create_rewards_epoch")
                    .with("epoch", epoch_pda(at))
                    .with("epoch_claimed", epoch_claimed_pda(at))
                    .with_args(&(at, tree.root(), total))
                    .instruction();
                // The epoch accounts are created before the handler runs.
                let expect = if m.epoch_exists(at) {
                    Expect::Code(ACCOUNT_ALREADY_IN_USE)
                } else if m.paused(Program::Mint) {
                    mint_err("ProtocolPaused")
                } else if total == 0 {
                    mint_err("InvalidAmount")
                } else if at < FIRST_CAPPED_EPOCH {
                    mint_err("EpochIndexBelowFirstCapped")
                } else if at != m.last_epoch + 1 {
                    mint_err("EpochIndexNotContiguous")
                } else if total > m.max_cap {
                    mint_err("EpochCapAboveGlobal")
                } else {
                    Expect::Ok
                };
                (ix, expect)
            };
            // Occasionally probe the index and budget guards before the valid create.
            let probe = match t.random_from_range(0..7u8) {
                0 => Some((
                    t.random_from_range(0..FIRST_CAPPED_EPOCH),
                    total,
                    "below first capped",
                )),
                1 => Some((
                    index + t.random_from_range(1..=3u64),
                    total,
                    "not contiguous",
                )),
                2 => Some((index, m.max_cap + 1, "above global cap")),
                3 => Some((index, 0, "zero total")),
                _ => None,
            };
            if let Some((at, total, case)) = probe {
                let (ix, expect) = create(at, total);
                run(t, ix, case, expect);
            }
            let total = total.min(m.max_cap);
            let (ix, expect) = create(index, total);
            if !run(t, ix, "", expect) {
                return;
            }
            m.last_epoch = index;
            total
        };
        let claimed = vec![false; leaves.len()];
        m.epochs.push(Epoch {
            index,
            total,
            cap: m.max_cap,
            capped: index >= FIRST_CAPPED_EPOCH,
            tree,
            leaves,
            claimed,
            claimed_sum: 0,
        });
    }

    #[flow]
    fn claim(&mut self) {
        let (t, m) = self.begin();
        if m.epochs.is_empty() {
            return;
        }
        let e = t.random_from_range(0..m.epochs.len());
        let epoch = &m.epochs[e];
        let leaf = t.random_from_range(0..epoch.leaves.len());
        let (owner, amount) = epoch.leaves[leaf];
        let mut proof = epoch.tree.proof(leaf);
        let mut claimant = owner;
        let mut claim_amount = amount;
        let corrupt = match t.random_from_range(0..4u8) {
            0 => {
                claim_amount += 1;
                true
            }
            1 if USERS > 1 => {
                claimant = (owner + 1) % USERS;
                true
            }
            2 if proof.iter().any(|(s, _)| *s != [0; 32]) => {
                let (sibling, is_left) = proof.iter_mut().find(|(s, _)| *s != [0; 32]).unwrap();
                if t.random_bool() {
                    sibling[t.random_from_range(0..32usize)] ^= 1 << t.random_from_range(0..8u32);
                } else {
                    *is_left = !*is_left;
                }
                true
            }
            _ => false,
        };
        let user = &m.world.users[claimant];
        // The claim record is created per (epoch, user) before the proof is checked.
        let has_record = epoch
            .leaves
            .iter()
            .zip(&epoch.claimed)
            .any(|((u, _), done)| *u == claimant && *done);
        let expect = if has_record {
            Expect::Code(ACCOUNT_ALREADY_IN_USE)
        } else if m.paused(Program::Mint) {
            mint_err("ProtocolPaused")
        } else if corrupt {
            mint_err("InvalidMerkleProof")
        } else if epoch.capped && epoch.claimed_sum + amount > epoch.total {
            mint_err("EpochCapExceeded")
        } else if m.frozen(user.wylds) {
            Expect::Code(SPL_ACCOUNT_FROZEN)
        } else {
            Expect::Ok
        };
        let ix = m
            .world
            .mint_call_for("claim_rewards", claimant)
            .with("epoch", epoch_pda(epoch.index))
            .with("epoch_claimed", epoch_claimed_pda(epoch.index))
            .with_args(&(claim_amount, proof))
            .instruction();
        let before = token_balance(t, user.wylds);
        let case = if epoch.capped { "capped" } else { "uncapped" };
        let claimed = run(t, ix, case, expect);
        let delta = if claimed { amount } else { 0 };
        assert_eq!(
            token_balance(t, user.wylds),
            before + delta,
            "claim balance"
        );
        if claimed {
            let epoch = &mut m.epochs[e];
            epoch.claimed[leaf] = true;
            epoch.claimed_sum += amount;
            m.unbacked += amount;
        }
    }

    #[flow]
    fn request_redeem(&mut self) {
        let (t, m) = self.begin();
        let u = t.random_from_range(0..USERS);
        let wylds = m.world.users[u].wylds;
        let balance = token_balance(t, wylds);
        let amount = pick_amount(t, balance.min(200_000_000_000));
        let expect = if m.pending_redeem[u].is_some() {
            Expect::Code(ACCOUNT_ALREADY_IN_USE)
        } else if m.paused(Program::Mint) {
            mint_err("ProtocolPaused")
        } else if amount == 0 {
            mint_err("InvalidAmount")
        } else if amount > balance {
            mint_err("InsufficientBalance")
        } else if m.frozen(wylds) {
            Expect::Code(SPL_ACCOUNT_FROZEN)
        } else {
            Expect::Ok
        };
        let ix = m
            .world
            .mint_call_for("request_redeem", u)
            .with_args(&amount)
            .instruction();
        if run(t, ix, "", expect) {
            m.pending_redeem[u] = Some(amount);
        }
    }

    #[flow]
    fn cancel_redeem(&mut self) {
        let (t, m) = self.begin();
        let u = t.random_from_range(0..USERS);
        // Cancelling revokes the burn delegate, which SPL Token refuses on a frozen account.
        let expect = match m.pending_redeem[u] {
            None => Expect::Code(ANCHOR_ACCOUNT_NOT_INITIALIZED),
            Some(_) if m.frozen(m.world.users[u].wylds) => Expect::Code(SPL_ACCOUNT_FROZEN),
            Some(_) => Expect::Ok,
        };
        let ix = m.world.mint_call_for("cancel_redeem", u).instruction();
        if run(t, ix, "", expect) {
            m.pending_redeem[u] = None;
        }
    }

    #[flow]
    fn fund_redeem_vault(&mut self) {
        let (t, m) = self.begin();
        let amount = t.random_from_range(1..=100_000_000_000u64);
        m.world.mint_usdc(t, m.redeem_vault, amount);
        m.usdc_minted += amount;
        m.funded += amount;
    }

    #[flow]
    fn complete_redeem(&mut self) {
        let (t, m) = self.begin();
        let u = t.random_from_range(0..USERS);
        let user = &m.world.users[u];
        let admin = pick_signer(t, m.admins(Program::Mint, Role::Rewards));
        let (redeem_vault, stale) = m.pick_redeem_vault(t);
        let call = m
            .world
            .mint_call_for("complete_redeem", u)
            .with("admin", admin)
            .with("redeem_vault_token_account", redeem_vault);
        let request = call.account("redemption_request");
        let wylds = token_balance(t, user.wylds);
        let usdc = token_balance(t, user.usdc);
        let vault = token_balance(t, redeem_vault);

        let (approved, expect) = match m.pending_redeem[u] {
            None => (1, Expect::Code(ANCHOR_ACCOUNT_NOT_INITIALIZED)),
            Some(amount) => {
                let approved = if t.random_from_range(0..8u8) == 0 {
                    amount + 1
                } else {
                    amount
                };
                let expect = if stale.is_some() {
                    mint_err("InvalidRedeemVault")
                } else if !m.is_admin(Program::Mint, Role::Rewards, &admin) {
                    mint_err("InvalidRewardsAdministrator")
                } else if approved != amount {
                    mint_err("RedemptionAmountMismatch")
                } else if wylds < amount {
                    mint_err("InsufficientRedemptionBalance")
                } else if vault < amount {
                    mint_err("InsufficientVaultBalance")
                } else if m.frozen(user.wylds) {
                    Expect::Code(SPL_ACCOUNT_FROZEN)
                } else {
                    Expect::Ok
                };
                (approved, expect)
            }
        };
        let short_vault = matches!(m.pending_redeem[u], Some(a) if vault < a);
        let ix = call.with_args(&approved).instruction();
        let case = match (stale, short_vault) {
            (Some(_), _) => "stale redeem vault",
            (_, true) => "short vault",
            _ => "",
        };
        if run(t, ix, case, expect) {
            let amount = m.pending_redeem[u].take().unwrap();
            assert_eq!(token_balance(t, user.wylds), wylds - amount);
            assert_eq!(token_balance(t, user.usdc), usdc + amount);
            assert_eq!(token_balance(t, redeem_vault), vault - amount);
            assert_eq!(t.get_account(&request).lamports(), 0, "request closed");
            m.backed -= amount;
        }
    }

    #[flow]
    fn sweep(&mut self) {
        let (t, m) = self.begin();
        let signer = pick_signer(t, m.admins(Program::Mint, Role::Rewards));
        let (from, from_case) = m.pick_redeem_vault(t);
        let (to, to_case) = m.pick_mint_vault(t);
        let vault = token_balance(t, from);
        let treasury = token_balance(t, to);
        let amount = pick_amount(t, vault);
        let to_error = m.mint_vault_error(t, to);
        let expect = if from_case.is_some() {
            mint_err("InvalidRedeemVault")
        } else if let Some(err) = to_error {
            err
        } else if !m.is_admin(Program::Mint, Role::Rewards, &signer) {
            mint_err("InvalidRewardsAdministrator")
        } else if amount == 0 {
            mint_err("InvalidAmount")
        } else if amount > vault {
            mint_err("InsufficientRedeemVaultFunds")
        } else {
            Expect::Ok
        };
        let ix = m
            .world
            .call(Program::Mint, "sweep_redeem_vault_funds")
            .with("signer", signer)
            .with("redeem_vault_token_account", from)
            .with("vault_token_account", to)
            .with_args(&amount)
            .instruction();
        let case = match (from_case, to_case) {
            (Some(_), _) => "stale redeem vault",
            (_, case) => case.unwrap_or(""),
        };
        if run(t, ix, case, expect) {
            assert_eq!(token_balance(t, from), vault - amount);
            assert_eq!(token_balance(t, to), treasury + amount);
        }
    }

    /// Repoints the deposit vault or the redeem vault; later flows must use only the new one.
    /// Candidates include accounts with another owner and a wYLDS (wrong mint) account.
    #[flow]
    fn update_vaults(&mut self) {
        let (t, m) = self.begin();
        let w = &m.world;
        let wrong_mint = w.users[0].wylds;
        if t.random_bool() {
            let candidates = [
                w.mint_vault,
                w.spare_mint_vault,
                w.foreign_vault,
                wrong_mint,
            ];
            let to = candidates[t.random_from_range(0..candidates.len())];
            // Any owner is accepted; the new owner becomes `config.vault_authority`.
            let expect = if to == wrong_mint {
                mint_err("InvalidVaultMint")
            } else {
                Expect::Ok
            };
            let ix = w
                .call(Program::Mint, "update_vault_token_account")
                .with("vault_token_account", to)
                .instruction();
            if run(t, ix, "", expect) {
                m.vault = to;
            }
        } else {
            let candidates = [
                w.redeem_vault,
                w.spare_redeem_vault,
                w.mint_vault,
                w.foreign_vault,
                wrong_mint,
            ];
            let to = candidates[t.random_from_range(0..candidates.len())];
            let expect = if to == wrong_mint {
                mint_err("InvalidVaultMint")
            } else if to == w.mint_vault || to == w.foreign_vault {
                mint_err("InvalidVaultAuthority")
            } else {
                Expect::Ok
            };
            let ix = w
                .call(Program::Mint, "update_redeem_vault")
                .with("redeem_vault_token_account", to)
                .instruction();
            if run(t, ix, "", expect) {
                m.redeem_vault = to;
            }
        }
    }

    #[flow]
    fn register_external_program(&mut self) {
        let (t, m) = self.begin();
        let program = candidate(t, &m.world);
        let expect = if program == m.world.wylds_mint {
            Expect::Code(ANCHOR_CONSTRAINT_EXECUTABLE)
        } else if m.allowed.contains(&program) || m.allowed.len() < m.limit as usize {
            Expect::Ok
        } else {
            mint_err("TooManyAllowedExternalMintPrograms")
        };
        let ix = m
            .world
            .call(Program::Mint, "register_allowed_external_mint_program")
            .with("external_program", program)
            .instruction();
        if run(t, ix, "", expect) && !m.allowed.contains(&program) {
            m.allowed.push(program);
        }
    }

    #[flow]
    fn update_external_program_limit(&mut self) {
        let (t, m) = self.begin();
        let limit = t.random_from_range(0..=EXECUTABLES.len() as u8 + 2);
        let ix = m
            .world
            .call(Program::Mint, "update_external_mint_programs_limit")
            .with_args(&limit)
            .instruction();
        run(t, ix, "", Expect::Ok);
        m.limit = limit;
    }

    #[flow]
    fn external_program_mint(&mut self) {
        let (t, m) = self.begin();
        let program = candidate(t, &m.world);
        let u = t.random_from_range(0..USERS);
        let amount = t.random_from_range(1..=1_000_000_000u64);
        let admin = pick_signer(t, m.admins(Program::Mint, Role::Rewards));
        // Occasionally probe the CPI-only guard with a direct call.
        let direct = t.random_from_range(0..8u8) == 0;
        let destination = m.world.users[u].wylds;
        let expect = if program == m.world.wylds_mint {
            Expect::Code(ANCHOR_CONSTRAINT_EXECUTABLE)
        } else if direct {
            mint_err("ExternalMintMustBeCpi")
        } else if m.paused(Program::Mint) {
            mint_err("ProtocolPaused")
        } else if !m.is_admin(Program::Mint, Role::Rewards, &admin) {
            mint_err("InvalidRewardsAdministrator")
        } else if program != stake_id() && !m.allowed.contains(&program) {
            mint_err("InvalidMintProgramCaller")
        } else if m.frozen(destination) {
            Expect::Code(SPL_ACCOUNT_FROZEN)
        } else {
            Expect::Ok
        };
        let before = token_balance(t, destination);
        let ix = m
            .world
            .mint_call_for("external_program_mint", u)
            .with("calling_program", program)
            .with("admin", admin)
            .with_args(&amount)
            .instruction();
        let (ix, case) = if direct {
            (ix, "direct")
        } else {
            (via_cpi(ix), "")
        };
        let minted = if run(t, ix, case, expect) { amount } else { 0 };
        assert_eq!(token_balance(t, destination), before + minted);
        m.unbacked += minted;
    }

    #[flow]
    fn pause(&mut self) {
        let (t, m) = self.begin();
        let program = pick_program(t);
        let signer = pick_signer(t, m.admins(program, Role::Freeze));
        // Mostly unpause, so paused stretches stay short.
        let pause = t.random_from_range(0..4u8) == 0;
        let expect = if m.is_admin(program, Role::Freeze, &signer) {
            Expect::Ok
        } else {
            err(program, "UnauthorizedFreezeAdministrator")
        };
        let ix = m
            .world
            .call(program, "pause")
            .with("signer", signer)
            .with_args(&pause)
            .instruction();
        let case = if pause { "pause" } else { "unpause" };
        if run(t, ix, case, expect) {
            if pause {
                m.paused.insert(program);
            } else {
                m.paused.remove(&program);
            }
        }
    }

    /// Freezes or thaws a user's wYLDS (vault-mint) or PRIME (vault-stake) account.
    #[flow]
    fn freeze_or_thaw(&mut self) {
        let (t, m) = self.begin();
        let program = pick_program(t);
        let user = &m.world.users[t.random_from_range(0..USERS)];
        let account = match program {
            Program::Mint => user.wylds,
            Program::Stake => user.prime,
        };
        let signer = pick_signer(t, m.admins(program, Role::Freeze));
        let freeze = t.random_from_range(0..3u8) == 0;
        let expect = if !m.is_admin(program, Role::Freeze, &signer) {
            err(program, "UnauthorizedFreezeAdministrator")
        } else if freeze == m.frozen(account) {
            Expect::Code(SPL_INVALID_STATE)
        } else {
            Expect::Ok
        };
        let name = if freeze {
            "freeze_token_account"
        } else {
            "thaw_token_account"
        };
        let ix = m
            .world
            .call(program, name)
            .with("token_account", account)
            .with("signer", signer)
            .instruction();
        let case = match (freeze, m.frozen(account)) {
            (true, true) => "already frozen",
            (false, false) => "not frozen",
            _ => "",
        };
        if run(t, ix, case, expect) {
            if freeze {
                m.frozen.insert(account);
            } else {
                m.frozen.remove(&account);
            }
        }
    }

    /// A plain SPL transfer of wYLDS or PRIME between users, which freezing must block.
    #[flow]
    fn transfer(&mut self) {
        let (t, m) = self.begin();
        let a = t.random_from_range(0..USERS);
        let b = (a + t.random_from_range(1..USERS)) % USERS;
        let (from, to) = if t.random_bool() {
            (m.world.users[a].wylds, m.world.users[b].wylds)
        } else {
            (m.world.users[a].prime, m.world.users[b].prime)
        };
        let (from_before, to_before) = (token_balance(t, from), token_balance(t, to));
        let amount = pick_amount(t, from_before);
        let expect = if m.frozen(from) || m.frozen(to) {
            Expect::Code(SPL_ACCOUNT_FROZEN)
        } else if amount > from_before {
            Expect::Code(SPL_INSUFFICIENT_FUNDS)
        } else {
            Expect::Ok
        };
        let ix = spl_transfer(from, to, m.world.users[a].key, amount);
        if run(t, ix, "transfer", expect) {
            assert_eq!(token_balance(t, from), from_before - amount);
            assert_eq!(token_balance(t, to), to_before + amount);
        }
    }

    #[flow]
    fn update_admins(&mut self) {
        let (t, m) = self.begin();
        let program = pick_program(t);
        let role = if t.random_bool() {
            Role::Freeze
        } else {
            Role::Rewards
        };
        let list = admin_list(t);
        let duplicate = list.iter().enumerate().any(|(i, k)| list[..i].contains(k));
        // vault-stake only bounds the length; vault-mint also rejects empty and duplicate lists.
        let expect = match program {
            Program::Mint if list.is_empty() => mint_err("EmptyAdministrators"),
            _ if list.len() > MAX_ADMINISTRATORS => err(program, "TooManyAdministrators"),
            Program::Mint if duplicate => mint_err("DuplicateAdministrators"),
            _ => Expect::Ok,
        };
        let ix = m
            .world
            .call(program, role.update())
            .with_args(&list)
            .instruction();
        if run(t, ix, "", expect) {
            m.admins.insert((program, role), list);
        }
    }

    /// `update_max_epoch_cap` or `update_last_rewards_epoch`. Rewinding the epoch counter makes
    /// `create_epoch` collide with existing epochs, which must not reopen them.
    #[flow]
    fn update_epoch_config(&mut self) {
        let (t, m) = self.begin();
        let w = &m.world;
        if t.random_bool() {
            let cap = match t.random_from_range(0..4u8) {
                0 => 0,
                1 => MAX_EPOCH_CAP,
                // Within the range of epoch totals, so the cap binds.
                _ => t.random_from_range(1..=100_000_000u64),
            };
            let expect = if cap == 0 {
                mint_err("InvalidGlobalCap")
            } else {
                Expect::Ok
            };
            let ix = w
                .call(Program::Mint, "update_max_epoch_cap")
                .with_args(&cap)
                .instruction();
            if run(t, ix, "", expect) {
                m.max_cap = cap;
            }
        } else {
            let highest = m
                .epochs
                .iter()
                .filter(|e| e.capped)
                .map(|e| e.index)
                .max()
                .unwrap_or(FIRST_CAPPED_EPOCH - 1);
            let (index, case) = match t.random_from_range(0..5u8) {
                0 => (
                    t.random_from_range(0..FIRST_CAPPED_EPOCH - 1),
                    "below first capped",
                ),
                1 => (
                    m.last_epoch.saturating_sub(t.random_from_range(1..=3u64)),
                    "rewind",
                ),
                2 => (m.last_epoch + t.random_from_range(1..=3u64), "skip"),
                _ => (highest, "restore"),
            };
            let expect = if index + 1 < FIRST_CAPPED_EPOCH {
                mint_err("EpochIndexBelowFirstCapped")
            } else {
                Expect::Ok
            };
            let ix = w
                .call(Program::Mint, "update_last_rewards_epoch")
                .with_args(&index)
                .instruction();
            if run(t, ix, case, expect) {
                m.last_epoch = index;
            }
        }
    }

    /// Repeats a one-shot initializer, which must fail without changing any state.
    #[flow]
    fn reinitialize(&mut self) {
        let (t, m) = self.begin();
        let (program, name) = ONE_SHOT[t.random_from_range(0..ONE_SHOT.len())];
        let ix = m.world.call(program, name).instruction();
        run(t, ix, "", Expect::Code(ACCOUNT_ALREADY_IN_USE));
    }

    #[flow]
    fn stake_price_report(&mut self) {
        let (t, m) = self.begin();
        let now = pin_clock(t, m);
        let signer = pick_signer(t, m.admins(Program::Stake, Role::Rewards));
        let random = now - t.random_from_range(-2..=m.staleness);
        let observed = edge_or(t, &[now, now + 1, m.price_ts, m.price_ts + 1], random);
        let random = observed - t.random_from_range(-1..=10i64);
        let valid_from = edge_or(t, &[now, now + 1, observed, observed + 1], random).max(0);
        let random = now + t.random_from_range(-2..=120i64);
        let expires_at = edge_or(t, &[now, now - 1, observed, observed - 1], random).max(0);
        let feed = if t.random_from_range(0..10u8) == 0 {
            other_feed(m.feed)
        } else {
            m.feed
        };
        let price = pick_price(t, m.scale);

        let expect = if !m.is_admin(Program::Stake, Role::Rewards, &signer) {
            stake_err("InvalidRewardsAdministrator")
        } else if now < valid_from {
            stake_err("FutureReportValidFromTimestamp")
        } else if now > expires_at {
            stake_err("ReportStale")
        } else if feed != m.feed {
            stake_err("InvalidFeedId")
        } else if !(valid_from <= observed && observed <= expires_at) {
            stake_err("InvalidReportTimestamps")
        } else if observed > now {
            stake_err("FutureObservationTimestamp")
        } else if m.price_ts != 0 && observed <= m.price_ts {
            stake_err("ObservationTimestampNotIncreasing")
        } else {
            Expect::Ok
        };
        let report = report_v7(
            feed,
            valid_from as u32,
            observed as u32,
            expires_at as u32,
            price,
        );
        let ix = m
            .world
            .call(Program::Stake, "apply_verified_report_for_testing")
            .with("signer", signer)
            .with_args(&report)
            .instruction();
        if run(t, ix, "", expect) {
            m.price = price;
            m.price_ts = observed;
        }
    }

    /// The Chainlink verifier is not deployed, so `verify_price` can only get as far as its CPI;
    /// this checks the authorization and account checks in front of it.
    #[flow]
    fn verify_price(&mut self) {
        let (t, m) = self.begin();
        let signer = pick_signer(t, m.admins(Program::Stake, Role::Rewards));
        let [program, verifier, controller] = m.chainlink;
        let mut call = m
            .world
            .call(Program::Stake, "verify_price")
            .with("signer", signer)
            .with("chainlink_program", program)
            .with("chainlink_verifier_account", verifier)
            .with("chainlink_access_controller", controller);
        let mut mismatch = false;
        for account in [
            "chainlink_program",
            "chainlink_verifier_account",
            "chainlink_access_controller",
        ] {
            if t.random_from_range(0..6u8) == 0 {
                call = call.with(account, t.random_pubkey());
                mismatch = true;
            }
        }
        let expect = if !m.is_admin(Program::Stake, Role::Rewards, &signer) {
            stake_err("InvalidRewardsAdministrator")
        } else if mismatch {
            stake_err("InvalidAuthority")
        } else {
            // Nothing is deployed at the Chainlink program address the CPI targets.
            Expect::Runtime(InstructionError::AccountNotExecutable)
        };
        run(t, call.instruction(), "", expect);
    }

    /// A change to the feed, scale or any Chainlink account invalidates the stored price; a
    /// staleness change keeps it. Changes are rare so that most deposits see a price.
    #[flow]
    fn update_price_config(&mut self) {
        let (t, m) = self.begin();
        let scale = match t.random_from_range(0..16u8) {
            0 => 0,
            1 => 1_000_000,
            2 => 1_000_000_000_000,
            _ => m.scale,
        };
        let feed = if t.random_from_range(0..16u8) == 0 {
            other_feed(m.feed)
        } else {
            m.feed
        };
        let mut chainlink = m.chainlink;
        if t.random_from_range(0..16u8) == 0 {
            let i = t.random_from_range(0..3usize);
            chainlink[i] = if chainlink[i] == OTHER_CHAINLINK {
                [
                    CHAINLINK_PROGRAM,
                    CHAINLINK_VERIFIER,
                    CHAINLINK_ACCESS_CONTROLLER,
                ][i]
            } else {
                OTHER_CHAINLINK
            };
        }
        let staleness = if t.random_bool() {
            m.staleness
        } else {
            t.random_from_range(0..=2 * PRICE_MAX_STALENESS)
        };
        let [program, verifier, controller] = chainlink;
        let ix = m
            .world
            .call(Program::Stake, "update_price_config")
            .with_args(&(program, verifier, controller, feed, scale, staleness))
            .instruction();
        let invalidates = scale != m.scale || feed != m.feed || chainlink != m.chainlink;
        let case = if invalidates { "invalidates price" } else { "" };
        run(t, ix, case, Expect::Ok);
        if invalidates {
            m.price = 0;
            m.price_ts = 0;
        }
        (m.scale, m.feed, m.chainlink, m.staleness) = (scale, feed, chainlink, staleness);
    }

    /// The conversion views ignore pause and staleness; only the stored price and scale matter.
    #[flow]
    fn views(&mut self) {
        let (t, m) = self.begin();
        let amount = pick_amount(t, 1_000_000_000_000);
        let price = m.price.max(0) as u128;
        let scale = m.scale as u128;
        let (name, value) = match t.random_from_range(0..3u8) {
            0 => ("shares_to_assets", mul_div(amount, price, scale)),
            1 => ("assets_to_shares", mul_div(amount, scale, price)),
            _ => ("exchange_rate", mul_div(EXCHANGE_RATE_SCALE, price, scale)),
        };
        let expect = match value {
            _ if m.price <= 0 => stake_err("PriceNotInitialized"),
            Err(e) => stake_err(e),
            Ok(_) => Expect::Ok,
        };
        let mut call = m.world.call(Program::Stake, name);
        if name != "exchange_rate" {
            call = call.with_args(&amount);
        }
        let (ok, logs) = run_result(t, call.instruction(), "", expect);
        if ok {
            assert_eq!(Ok(view_value(&logs, name)), value, "{name}");
        }
    }

    #[flow]
    fn stake_deposit(&mut self) {
        let (t, m) = self.begin();
        let u = t.random_from_range(0..USERS);
        let user = &m.world.users[u];
        let wylds = token_balance(t, user.wylds);
        let prime = token_balance(t, user.prime);
        let vault = token_balance(t, m.world.stake_vault);
        let supply = mint_supply(t, m.world.prime_mint);
        let amount = pick_amount(t, wylds);
        let now = pin_clock(t, m);

        let shares = mul_div(amount, m.scale as u128, m.price.max(0) as u128);
        let expect = if amount == 0 {
            stake_err("InvalidAmount")
        } else if m.paused(Program::Stake) {
            stake_err("ProtocolPaused")
        } else if let Some(err) = price_error(m, now) {
            err
        } else {
            match shares {
                Err(e) => stake_err(e),
                Ok(0) => stake_err("DepositTooSmall"),
                Ok(_) if m.frozen(user.wylds) => Expect::Code(SPL_ACCOUNT_FROZEN),
                Ok(_) if amount > wylds => Expect::Code(SPL_INSUFFICIENT_FUNDS),
                Ok(_) if m.frozen(user.prime) => Expect::Code(SPL_ACCOUNT_FROZEN),
                Ok(s) if supply.checked_add(s).is_none() => Expect::Code(SPL_OVERFLOW),
                Ok(_) => Expect::Ok,
            }
        };
        let ix = m
            .world
            .stake_call_for("deposit", u)
            .with_args(&amount)
            .instruction();
        if run(t, ix, staleness_case(m, now), expect) {
            let minted = token_balance(t, user.prime) - prime;
            assert_eq!(Ok(minted), shares);
            assert_eq!(token_balance(t, user.wylds), wylds - amount);
            assert_eq!(token_balance(t, m.world.stake_vault), vault + amount);
            // The minted shares are worth no more than the deposit.
            let value = (minted as u128).checked_mul(m.price as u128);
            assert!(
                value.is_some_and(|v| v <= amount as u128 * m.scale as u128),
                "deposit of {amount} minted {minted} shares at price {}",
                m.price
            );
        }
    }

    #[flow]
    fn stake_redeem(&mut self) {
        let (t, m) = self.begin();
        let u = t.random_from_range(0..USERS);
        let user = &m.world.users[u];
        let wylds = token_balance(t, user.wylds);
        let prime = token_balance(t, user.prime);
        let vault = token_balance(t, m.world.stake_vault);
        let shares = pick_amount(t, prime);
        let now = pin_clock(t, m);

        let assets = mul_div(shares, m.price.max(0) as u128, m.scale as u128);
        let expect = if shares == 0 {
            stake_err("InvalidAmount")
        } else if m.paused(Program::Stake) {
            stake_err("ProtocolPaused")
        } else if let Some(err) = price_error(m, now) {
            err
        } else if shares > prime {
            stake_err("InsufficientBalance")
        } else {
            match assets {
                Err(e) => stake_err(e),
                Ok(0) => stake_err("InvalidAmount"),
                Ok(a) if a > vault => stake_err("InsufficientVaultBalance"),
                Ok(_) if m.frozen(user.prime) || m.frozen(user.wylds) => {
                    Expect::Code(SPL_ACCOUNT_FROZEN)
                }
                Ok(_) => Expect::Ok,
            }
        };
        let ix = m
            .world
            .stake_call_for("redeem", u)
            .with_args(&shares)
            .instruction();
        if run(t, ix, staleness_case(m, now), expect) {
            let paid = token_balance(t, user.wylds) - wylds;
            assert_eq!(Ok(paid), assets);
            assert_eq!(token_balance(t, user.prime), prime - shares);
            assert_eq!(token_balance(t, m.world.stake_vault), vault - paid);
            // The vault pays out no more than the burned shares are worth.
            assert!(
                paid as u128 * m.scale as u128 <= shares as u128 * m.price as u128,
                "redeem of {shares} shares paid {paid} at price {}",
                m.price
            );
        }
    }

    /// Deposits, then redeems exactly the minted shares at the same price and time. Checked from
    /// observed balances only, so it does not rely on the model's conversion formula.
    #[flow]
    fn stake_round_trip(&mut self) {
        let (t, m) = self.begin();
        let u = t.random_from_range(0..USERS);
        let user = &m.world.users[u];
        let wylds = token_balance(t, user.wylds);
        let prime = token_balance(t, user.prime);
        if wylds == 0 {
            return;
        }
        let amount = match t.random_from_range(0..4u8) {
            0 => 1,
            1 => wylds,
            _ => t.random_from_range(1..=wylds),
        };
        pin_clock(t, m);
        let deposit = m
            .world
            .stake_call_for("deposit", u)
            .with_args(&amount)
            .instruction();
        if !t
            .process_transaction(&[deposit], Some("round_trip deposit"))
            .is_success()
        {
            return;
        }
        let shares = token_balance(t, user.prime) - prime;
        pin_clock(t, m);
        let redeem = m
            .world
            .stake_call_for("redeem", u)
            .with_args(&shares)
            .instruction();
        let result = t.process_transaction(&[redeem], Some("round_trip redeem"));
        if result.is_success() {
            assert_eq!(
                token_balance(t, user.prime),
                prime,
                "round trip burns the minted shares"
            );
        } else {
            // The minted shares are worth less than one base unit.
            assert_eq!(
                result.get_custom_error_code(),
                Some(stake_idl().error("InvalidAmount"))
            );
        }
        let back = token_balance(t, user.wylds) - (wylds - amount);
        assert!(back <= amount, "redeem(deposit({amount})) returned {back}");
    }

    #[flow]
    fn publish_rewards(&mut self) {
        let (t, m) = self.begin();
        let admin = pick_signer(t, m.admins(Program::Stake, Role::Rewards));
        let r = &m.rewards;
        let id = match t.random_from_range(0..8u8) {
            0 => r.last_id.saturating_sub(t.random_from_range(0..=1u32)),
            1 => r.last_id.saturating_add(MAX_GAP + 1),
            2 => r.last_id.saturating_add(MAX_GAP),
            _ => r.last_id.saturating_add(t.random_from_range(1..=3u32)),
        };
        let vault = token_balance(t, m.world.stake_vault);
        let bps_cap = (vault as u128 * r.bps as u128 / MAX_BPS as u128) as u64;
        let amount = match t.random_from_range(0..7u8) {
            0 => bps_cap,
            1 => bps_cap + 1,
            2 => r.period_cap,
            3 => r.period_cap + 1,
            4 => r.lifetime_cap.saturating_sub(r.distributed),
            5 => r
                .lifetime_cap
                .saturating_sub(r.distributed)
                .saturating_add(1),
            _ => t.random_from_range(0..=bps_cap.min(r.period_cap)),
        };
        let now = pin_clock(t, m);
        // The stake-side checks, then vault-mint's own checks on the external mint CPI.
        let expect = if r.published.contains(&(id, amount)) {
            // Replaying a published (id, amount) fails creating its record.
            Expect::Code(ACCOUNT_ALREADY_IN_USE)
        } else if m.paused(Program::Stake) {
            stake_err("ProtocolPaused")
        } else if !m.is_admin(Program::Stake, Role::Rewards, &admin) {
            stake_err("InvalidRewardsAdministrator")
        } else if amount == 0 {
            stake_err("InvalidAmount")
        } else if id <= r.last_id {
            stake_err("RewardPublicationIdNotMonotonic")
        } else if id - r.last_id > MAX_GAP {
            stake_err("RewardPublicationIdGapTooLarge")
        } else if vault > 0 && amount > bps_cap {
            stake_err("RewardExceedsMaxDelta")
        } else if amount > r.period_cap {
            stake_err("ExceedsPeriodRewardCap")
        } else if r.last_at > 0 && now < r.last_at + r.period_seconds {
            stake_err("RewardCooldownNotElapsed")
        } else if r.distributed + amount > r.lifetime_cap {
            stake_err("ExceedsLifetimeRewardCap")
        } else if m.paused(Program::Mint) {
            mint_err("ProtocolPaused")
        } else if !m.is_admin(Program::Mint, Role::Rewards, &admin) {
            mint_err("InvalidRewardsAdministrator")
        } else {
            Expect::Ok
        };
        let record = pda(
            &[b"reward_record", &id.to_le_bytes(), &amount.to_le_bytes()],
            &stake_id(),
        );
        let ix = m
            .world
            .call(Program::Stake, "publish_rewards")
            .with("admin", admin)
            .with("reward_record", record)
            .with_args(&(id, amount))
            .instruction();
        let published = run(t, ix, cooldown_case(r, now), expect);
        assert_eq!(
            token_balance(t, m.world.stake_vault),
            vault + if published { amount } else { 0 }
        );
        if published {
            let r = &mut m.rewards;
            r.last_id = id;
            r.last_at = now;
            r.distributed += amount;
            r.published.insert((id, amount));
            assert!(r.distributed <= r.lifetime_cap);
            m.unbacked += amount;
        }
    }

    #[flow]
    fn stake_reward_config_update(&mut self) {
        let (t, m) = self.begin();
        let r = &mut m.rewards;
        let call = |name| m.world.call(Program::Stake, name);
        match t.random_from_range(0..5u8) {
            0 => {
                let random = t.random_from_range(1..=MAX_BPS);
                let bps = edge_or(t, &[0, 1, MAX_BPS, MAX_BPS + 1], random);
                let ok = bps > 0 && bps <= MAX_BPS;
                let expect = if ok {
                    Expect::Ok
                } else {
                    stake_err("InvalidMaxRewardBps")
                };
                let ix = call("update_max_reward_bps").with_args(&bps).instruction();
                if run(t, ix, "", expect) {
                    r.bps = bps;
                }
            }
            1 => {
                let random = t.random_from_range(1..=5_000_000_000u64);
                let cap = edge_or(t, &[0, 1], random);
                let expect = if cap > 0 {
                    Expect::Ok
                } else {
                    stake_err("InvalidMaxPeriodRewards")
                };
                let ix = call("update_max_period_rewards")
                    .with_args(&cap)
                    .instruction();
                if run(t, ix, "", expect) {
                    r.period_cap = cap;
                }
            }
            2 => {
                let random = t.random_from_range(1..=600i64);
                let seconds = edge_or(t, &[i64::MIN, -1, 0, 1], random);
                let expect = if seconds > 0 {
                    Expect::Ok
                } else {
                    stake_err("InvalidRewardPeriodSeconds")
                };
                let ix = call("update_reward_period_seconds")
                    .with_args(&seconds)
                    .instruction();
                if run(t, ix, "", expect) {
                    r.period_seconds = seconds;
                }
            }
            3 => {
                let cap = r
                    .distributed
                    .saturating_add(t.random_from_range(0..=10_000_000_000u64));
                let cap = if t.random_bool() {
                    cap
                } else {
                    r.distributed.saturating_sub(1)
                };
                let expect = if cap > 0 && cap >= r.distributed {
                    Expect::Ok
                } else {
                    stake_err("InvalidMaxTotalRewards")
                };
                let ix = call("update_max_total_rewards")
                    .with_args(&cap)
                    .instruction();
                if run(t, ix, "", expect) {
                    r.lifetime_cap = cap;
                }
            }
            _ => {
                // Any floor is accepted; rewinding it lets an id be published again.
                let (id, case) = match t.random_from_range(0..4u8) {
                    0 => (
                        r.last_id.saturating_sub(t.random_from_range(1..=3u32)),
                        "rewind",
                    ),
                    1 => (r.last_id.saturating_add(MAX_GAP + 1), "beyond gap"),
                    2 => (u32::MAX, "max"),
                    _ => (
                        r.last_id.saturating_add(t.random_from_range(0..=MAX_GAP)),
                        "",
                    ),
                };
                let ix = call("update_last_reward_publication")
                    .with_args(&id)
                    .instruction();
                run(t, ix, case, Expect::Ok);
                r.last_id = id;
            }
        }
    }

    /// Moves the clock forward, often onto the price staleness or reward cooldown boundary.
    #[flow]
    fn warp(&mut self) {
        let (t, m) = self.begin();
        let now = m.now;
        let stale_at = m.price_ts + m.staleness;
        let cooldown_ends = m.rewards.last_at + m.rewards.period_seconds;
        let target = match t.random_from_range(0..6u8) {
            0 => stale_at,
            1 => stale_at + 1,
            2 => cooldown_ends - 1,
            3 => cooldown_ends,
            _ => now + t.random_from_range(0..=PRICE_MAX_STALENESS / 2),
        };
        m.now = target.max(now);
    }

    #[end]
    fn end(&mut self) {
        let (t, m) = self.begin();
        for epoch in &m.epochs {
            let data = t
                .get_account(&epoch_claimed_pda(epoch.index))
                .data()
                .to_vec();
            if !epoch.capped {
                assert!(
                    data.is_empty(),
                    "uncapped epoch {} has a claim counter",
                    epoch.index
                );
                continue;
            }
            let claimed = u64::from_le_bytes(data[8..16].try_into().unwrap());
            assert_eq!(
                claimed, epoch.claimed_sum,
                "epoch {} claimed_total",
                epoch.index
            );
            // RewardsEpoch: discriminator, index, merkle_root, then total.
            let account = t.get_account(&epoch_pda(epoch.index));
            let total = u64::from_le_bytes(account.data()[48..56].try_into().unwrap());
            assert_eq!(total, epoch.total, "epoch {} total", epoch.index);
            assert!(
                claimed <= total && total <= epoch.cap,
                "epoch {} claimed {claimed} of {total} under cap {}",
                epoch.index,
                epoch.cap
            );
        }
    }
}

/// Supply and balance invariants, cheap enough to check after every flow.
fn invariants(t: &mut Trident, m: &Model) {
    let w = &m.world;
    let sum = |t: &mut Trident, keys: &mut dyn Iterator<Item = Pubkey>| -> u64 {
        keys.map(|k| token_balance(t, k)).sum()
    };
    let wylds = sum(
        t,
        &mut w.users.iter().map(|u| u.wylds).chain([w.stake_vault]),
    );
    let supply = mint_supply(t, w.wylds_mint);
    assert_eq!(supply, wylds, "wYLDS supply equals holdings");
    assert_eq!(
        supply,
        m.backed + m.unbacked,
        "wYLDS supply is deposits not yet redeemed plus reward mints"
    );
    let vaults = [
        w.mint_vault,
        w.spare_mint_vault,
        w.foreign_vault,
        w.redeem_vault,
        w.spare_redeem_vault,
    ];
    let vault_usdc = sum(t, &mut vaults.into_iter());
    assert_eq!(
        vault_usdc,
        m.backed + m.funded,
        "vault USDC covers every deposited wYLDS"
    );
    let user_usdc = sum(t, &mut w.users.iter().map(|u| u.usdc));
    assert_eq!(user_usdc + vault_usdc, m.usdc_minted, "USDC is conserved");
    let prime = sum(t, &mut w.users.iter().map(|u| u.prime));
    assert_eq!(
        mint_supply(t, w.prime_mint),
        prime,
        "PRIME supply equals holdings"
    );
    check_state(t, m);
}

/// Borsh fields of an Anchor account, read in declaration order after the discriminator.
struct Fields {
    data: Vec<u8>,
    at: usize,
}

impl Fields {
    fn of(t: &mut Trident, key: Pubkey) -> Self {
        Self {
            data: t.get_account(&key).data().to_vec(),
            at: 8,
        }
    }

    fn take<const N: usize>(&mut self) -> [u8; N] {
        let bytes = self.data[self.at..self.at + N].try_into().unwrap();
        self.at += N;
        bytes
    }

    fn key(&mut self) -> Pubkey {
        Pubkey::new_from_array(self.take())
    }

    fn u64(&mut self) -> u64 {
        u64::from_le_bytes(self.take())
    }

    fn i64(&mut self) -> i64 {
        i64::from_le_bytes(self.take())
    }

    fn keys(&mut self) -> Vec<Pubkey> {
        let len = u32::from_le_bytes(self.take());
        (0..len).map(|_| self.key()).collect()
    }

    fn flag(&mut self) -> bool {
        self.take::<1>()[0] != 0
    }

    fn skip(&mut self, bytes: usize) {
        self.at += bytes;
    }
}

/// Every field of both programs' singleton state accounts equals the model, so no flow changes
/// state it was not expected to.
fn check_state(t: &mut Trident, m: &Model) {
    let (w, s) = (&m.world, &m.state);
    let admins = |program, role| m.admins(program, role).to_vec();

    let mut f = Fields::of(t, s.config);
    assert_eq!(f.key(), w.usdc_mint, "config.vault");
    assert_eq!(f.key(), w.wylds_mint, "config.mint");
    assert_eq!(
        f.keys(),
        admins(Program::Mint, Role::Freeze),
        "mint freeze admins"
    );
    assert_eq!(
        f.keys(),
        admins(Program::Mint, Role::Rewards),
        "mint rewards admins"
    );
    let vault_owner = token_owner(t, m.vault);
    assert_eq!(f.key(), vault_owner, "config.vault_authority");
    assert_eq!(f.key(), m.redeem_vault, "config.redeem_vault");
    f.skip(1); // bump, which no instruction rewrites
    assert_eq!(f.flag(), m.paused(Program::Mint), "mint paused");
    assert_eq!(f.key(), stake_id(), "config.allowed_external_mint_program");

    let mut f = Fields::of(t, s.epoch_caps);
    assert_eq!(f.u64(), m.max_cap, "max_epoch_cap");
    assert_eq!(f.u64(), FIRST_CAPPED_EPOCH, "first_capped_epoch");
    assert_eq!(
        Fields::of(t, s.last_rewards_epoch).u64(),
        m.last_epoch,
        "last rewards epoch"
    );
    assert_eq!(
        Fields::of(t, s.vault_config).key(),
        m.vault,
        "vault token account"
    );
    // Created by the first registration.
    let mut f = Fields::of(t, s.allowed_programs);
    let allowed = if f.data.is_empty() {
        Vec::new()
    } else {
        f.keys()
    };
    assert_eq!(allowed, m.allowed, "allowed programs");
    let limit = Fields::of(t, s.programs_limit).take::<1>()[0];
    assert_eq!(limit, m.limit, "external mint programs limit");

    let mut f = Fields::of(t, s.stake_config);
    assert_eq!(f.key(), w.wylds_mint, "stake_config.vault");
    assert_eq!(f.key(), w.prime_mint, "stake_config.mint");
    assert_eq!(f.i64(), m.unbonding_period, "unbonding_period");
    assert_eq!(
        f.keys(),
        admins(Program::Stake, Role::Freeze),
        "stake freeze admins"
    );
    assert_eq!(
        f.keys(),
        admins(Program::Stake, Role::Rewards),
        "stake rewards admins"
    );
    f.skip(1); // bump, which no instruction rewrites
    assert_eq!(f.flag(), m.paused(Program::Stake), "stake paused");

    let mut f = Fields::of(t, s.stake_vault_config);
    assert_eq!(f.key(), w.stake_vault, "stake vault token account");
    assert_eq!(f.key(), m.stake_vault_authority, "stake vault authority");

    let r = &m.rewards;
    let mut f = Fields::of(t, s.reward_config);
    assert_eq!(f.u64(), r.bps, "max_reward_bps");
    assert_eq!(f.u64(), r.period_cap, "max_period_rewards");
    assert_eq!(f.i64(), r.period_seconds, "reward_period_seconds");
    assert_eq!(f.i64(), r.last_at, "last_reward_distributed_at");
    assert_eq!(f.u64(), r.lifetime_cap, "max_total_rewards");
    assert_eq!(f.u64(), r.distributed, "total_rewards_distributed");
    assert!(
        r.distributed <= r.lifetime_cap,
        "distributed over the lifetime cap"
    );
    let last_id = u32::from_le_bytes(Fields::of(t, s.last_publication).take());
    assert_eq!(last_id, r.last_id, "last reward publication");

    let mut f = Fields::of(t, s.price_config);
    let chainlink = [f.key(), f.key(), f.key()];
    assert_eq!(chainlink, m.chainlink, "chainlink accounts");
    assert_eq!(f.take::<32>(), m.feed, "feed_id");
    assert_eq!(i128::from_le_bytes(f.take()), m.price, "price");
    assert_eq!(f.u64(), m.scale, "price_scale");
    assert_eq!(f.i64(), m.price_ts, "price_timestamp");
    assert_eq!(f.i64(), m.staleness, "price_max_staleness");
}

/// TridentSVM adds elapsed wall-clock time to the Clock after every transaction, so time-sensitive
/// flows reset it to the model's time right before their call.
fn pin_clock(t: &mut Trident, m: &Model) -> i64 {
    t.warp_to_timestamp(m.now);
    m.now
}

/// Mirrors the stored-price checks of deposit and redeem.
fn price_error(m: &Model, now: i64) -> Option<Expect> {
    if m.price_ts == 0 {
        Some(stake_err("PriceNotInitialized"))
    } else if now - m.price_ts > m.staleness {
        Some(stake_err("PriceTooStale"))
    } else if m.price <= 0 {
        Some(stake_err("PriceNotInitialized"))
    } else {
        None
    }
}

/// `value * mul / div` narrowed to u64, or the error the program's checked math raises.
fn mul_div(value: u64, mul: u128, div: u128) -> Result<u64, &'static str> {
    let product = (value as u128).checked_mul(mul).ok_or("Overflow")?;
    let quotient = product.checked_div(div).ok_or("DivisionByZero")?;
    u64::try_from(quotient).map_err(|_| "Overflow")
}

fn cooldown_case(r: &RewardConfig, now: i64) -> &'static str {
    let ends = r.last_at + r.period_seconds;
    if r.last_at == 0 {
        ""
    } else if now == ends {
        "cooldown just ended"
    } else if now == ends - 1 {
        "one second before cooldown end"
    } else {
        ""
    }
}

fn staleness_case(m: &Model, now: i64) -> &'static str {
    let age = now - m.price_ts;
    if age == m.staleness {
        "at staleness boundary"
    } else if age == m.staleness + 1 {
        "one second stale"
    } else {
        ""
    }
}

/// Zero, one, the full balance, one more than the balance, or anything up to the balance.
fn pick_amount(t: &mut Trident, balance: u64) -> u64 {
    match t.random_from_range(0..8u8) {
        0 => 0,
        1 => 1,
        2 => balance,
        3 => balance.saturating_add(1),
        4 => u64::MAX - t.random_from_range(0..=1_000u64),
        _ => t.random_from_range(0..=balance),
    }
}

fn pick_price(t: &mut Trident, scale: u64) -> i128 {
    match t.random_from_range(0..10u8) {
        0 => -t.random_from_range(0..=i128::MAX),
        1 => 0,
        2 => 1,
        // Log-uniform over the whole positive range, so every magnitude is reached.
        3 | 4 => {
            let bits = t.random_from_range(0..127u32);
            (1i128 << bits) | (t.random_from_range(0..=i128::MAX) & ((1i128 << bits) - 1))
        }
        _ => t.random_from_range(scale as i128 / 2..=scale as i128 * 2),
    }
}

fn pick_program(t: &mut Trident) -> Program {
    if t.random_bool() {
        Program::Mint
    } else {
        Program::Stake
    }
}

/// Usually a current administrator, otherwise any pool member (who may not be one).
fn pick_signer(t: &mut Trident, admins: &[Pubkey]) -> Pubkey {
    if !admins.is_empty() && t.random_from_range(0..4u8) != 0 {
        admins[t.random_from_range(0..admins.len())]
    } else {
        ADMIN_POOL[t.random_from_range(0..ADMIN_POOL.len())]
    }
}

/// Mostly 1-4 distinct pool members; otherwise empty, too long, or with a duplicate.
fn admin_list(t: &mut Trident) -> Vec<Pubkey> {
    let any = |t: &mut Trident| ADMIN_POOL[t.random_from_range(0..ADMIN_POOL.len())];
    match t.random_from_range(0..8u8) {
        0 => vec![],
        1 => (0..=MAX_ADMINISTRATORS).map(|_| any(t)).collect(),
        2 => {
            let key = any(t);
            vec![key, any(t), key]
        }
        _ => {
            let mut pool = ADMIN_POOL.to_vec();
            let len = t.random_from_range(1..=pool.len());
            (0..len)
                .map(|_| pool.swap_remove(t.random_from_range(0..pool.len())))
                .collect()
        }
    }
}

fn other_feed(feed: [u8; 32]) -> [u8; 32] {
    if feed == FEED_ID {
        OTHER_FEED
    } else {
        FEED_ID
    }
}

/// SPL Token `Transfer` signed by the source account's owner.
fn spl_transfer(from: Pubkey, to: Pubkey, owner: Pubkey, amount: u64) -> Instruction {
    let mut data = vec![3];
    data.extend(amount.to_le_bytes());
    Instruction::new_with_bytes(
        TOKEN_PROGRAM,
        &data,
        vec![
            AccountMeta::new(from, false),
            AccountMeta::new(to, false),
            AccountMeta::new_readonly(owner, true),
        ],
    )
}

/// Half the time one of the boundary values a check compares against, otherwise `random`.
fn edge_or<T: Copy>(t: &mut Trident, edges: &[T], random: T) -> T {
    if t.random_bool() {
        edges[t.random_from_range(0..edges.len())]
    } else {
        random
    }
}

/// An allow-list candidate: an executable, one of the vault programs, or a non-executable account.
fn candidate(t: &mut Trident, world: &World) -> Pubkey {
    let pool = [stake_id(), mint_id(), world.wylds_mint];
    let i = t.random_from_range(0..EXECUTABLES.len() + pool.len());
    if i < EXECUTABLES.len() {
        EXECUTABLES[i]
    } else {
        pool[i - EXECUTABLES.len()]
    }
}

fn allowed_programs(t: &mut Trident, world: &World) -> Vec<Pubkey> {
    let call = world.call(Program::Mint, "register_allowed_external_mint_program");
    let account = t.get_account(&call.account("allowed_external_mint_programs"));
    let data = account.data();
    if data.len() < 12 {
        return Vec::new();
    }
    let len = u32::from_le_bytes(data[8..12].try_into().unwrap()) as usize;
    data[12..12 + 32 * len]
        .chunks(32)
        .map(|k| Pubkey::try_from(k).unwrap())
        .collect()
}

/// Writes a `RewardsEpoch` below `first_capped_epoch`, as left behind by deployments that
/// predate epoch caps (the current program refuses to create one there).
fn inject_legacy_epoch(t: &mut Trident, index: u64, root: [u8; 32], total: u64) {
    let mut data = mint_idl().account_discriminator("RewardsEpoch").to_vec();
    data.extend(args(&(index, root, total, START_TIME)));
    let mut account = AccountSharedData::new(LAMPORTS_PER_SOL, data.len(), &mint_id());
    account.set_data_from_slice(&data);
    t.set_account_custom(&epoch_pda(index), &account);
}

fn main() {
    let env = |name: &str, default: u64| {
        std::env::var(name)
            .ok()
            .map_or(default, |v| v.parse().unwrap())
    };
    FuzzTest::fuzz(env("FUZZ_ITERATIONS", 200), env("FUZZ_FLOWS", 60));
}
