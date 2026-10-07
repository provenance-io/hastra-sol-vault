//! Stateful fuzzing of vault-mint and vault-stake (pool-prime) against the compiled programs.
//!
//! Each flow predicts the outcome of one instruction from an independent model (success, or the
//! exact error code) and checks the resulting balances; `end` checks supply conservation and
//! the per-epoch claim counters. Profiles: `FUZZ_ITERATIONS` x `FUZZ_FLOWS` (defaults below).
//! A failure prints `(seed: <hex>)`; rerun it alone with `TRIDENT_FUZZ_DEBUG=<hex>`.

use hastra_fuzz::world::*;
use trident_fuzz::fuzzing::*;

const USERS: usize = 3;
const MAX_GAP: u32 = 255;
const MAX_BPS: u64 = 10_000;
const ANCHOR_ACCOUNT_NOT_INITIALIZED: u32 = 3012;
const ANCHOR_CONSTRAINT_EXECUTABLE: u32 = 2007;
/// System program: `init` of an account that already exists.
const ACCOUNT_ALREADY_IN_USE: u32 = 0;
const SPL_INSUFFICIENT_FUNDS: u32 = 1;
const SPL_OVERFLOW: u32 = 14;

const EXECUTABLES: [Pubkey; 4] = [
    pubkey!("11111111111111111111111111111111"),
    TOKEN_PROGRAM,
    pubkey!("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"),
    SOME_EXECUTABLE,
];

enum Expect {
    Ok,
    Code(u32),
}

fn mint_err(name: &str) -> Expect {
    Expect::Code(mint_idl().error(name))
}

fn stake_err(name: &str) -> Expect {
    Expect::Code(stake_idl().error(name))
}

/// Runs `ix` and asserts the predicted outcome; returns whether it succeeded.
fn run(trident: &mut Trident, ix: Instruction, label: &str, expect: Expect) -> bool {
    let result = trident.process_transaction(&[ix], Some(label));
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
    }
    result.is_success()
}

struct Epoch {
    index: u64,
    total: u64,
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
}

struct Model {
    world: World,
    usdc_minted: u64,
    epochs: Vec<Epoch>,
    last_epoch: u64,
    unused_uncapped: Vec<u64>,
    pending_redeem: Vec<Option<u64>>,
    allowed: Vec<Pubkey>,
    limit: u8,
    price: i128,
    price_ts: i64,
    /// Authoritative time; flows pin the SVM clock to it before time-sensitive calls.
    now: i64,
    rewards: RewardConfig,
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
        let allowed = allowed_programs(t, &world);
        let mut model = Model {
            usdc_minted: USER_USDC * USERS as u64,
            epochs: Vec::new(),
            last_epoch: FIRST_CAPPED_EPOCH - 1,
            unused_uncapped: (0..FIRST_CAPPED_EPOCH).collect(),
            pending_redeem: vec![None; USERS],
            allowed,
            limit: MAX_EXTERNAL_PROGRAMS,
            price: PRICE_SCALE as i128,
            price_ts: START_TIME,
            now: START_TIME,
            rewards: RewardConfig {
                bps: 75,
                period_cap: 1_000_000_000_000,
                period_seconds: 3_540,
                lifetime_cap: 10_000_000_000_000,
                distributed: 0,
                last_at: 0,
                last_id: 0,
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
        self.fuzz_accounts = Some(model);
    }

    #[flow]
    fn create_epoch(&mut self) {
        let (t, m) = (&mut self.trident, self.fuzz_accounts.as_mut().unwrap());
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

        if uncapped {
            inject_legacy_epoch(t, index, tree.root(), total);
        } else {
            let create = |at: u64, total: u64| {
                m.world
                    .call(Program::Mint, "create_rewards_epoch")
                    .with("epoch", epoch_pda(at))
                    .with("epoch_claimed", epoch_claimed_pda(at))
                    .with_args(&(at, tree.root(), total))
                    .instruction()
            };
            // Occasionally probe the index and budget guards before the valid create.
            match t.random_from_range(0..6u8) {
                0 => {
                    let below = t.random_from_range(0..FIRST_CAPPED_EPOCH);
                    // Injected legacy epochs already occupy their index.
                    let expect = if m.unused_uncapped.contains(&below) {
                        mint_err("EpochIndexBelowFirstCapped")
                    } else {
                        Expect::Code(ACCOUNT_ALREADY_IN_USE)
                    };
                    run(
                        t,
                        create(below, total),
                        "create_epoch below first capped",
                        expect,
                    );
                }
                1 => {
                    let skip = index + t.random_from_range(1..=3u64);
                    run(
                        t,
                        create(skip, total),
                        "create_epoch not contiguous",
                        mint_err("EpochIndexNotContiguous"),
                    );
                }
                2 => {
                    let ix = create(index, MAX_EPOCH_CAP + 1);
                    run(
                        t,
                        ix,
                        "create_epoch above global cap",
                        mint_err("EpochCapAboveGlobal"),
                    );
                }
                _ => {}
            }
            run(t, create(index, total), "create_epoch", Expect::Ok);
            m.last_epoch = index;
        }
        let claimed = vec![false; leaves.len()];
        m.epochs.push(Epoch {
            index,
            total,
            capped: index >= FIRST_CAPPED_EPOCH,
            tree,
            leaves,
            claimed,
            claimed_sum: 0,
        });
    }

    #[flow]
    fn claim(&mut self) {
        let (t, m) = (&mut self.trident, self.fuzz_accounts.as_mut().unwrap());
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
        } else if corrupt {
            mint_err("InvalidMerkleProof")
        } else if epoch.capped && epoch.claimed_sum + amount > epoch.total {
            mint_err("EpochCapExceeded")
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
        let label = if epoch.capped {
            "claim capped"
        } else {
            "claim uncapped"
        };
        let claimed = run(t, ix, label, expect);
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
        }
    }

    #[flow]
    fn request_redeem(&mut self) {
        let (t, m) = (&mut self.trident, self.fuzz_accounts.as_mut().unwrap());
        let u = t.random_from_range(0..USERS);
        let balance = token_balance(t, m.world.users[u].wylds);
        let amount = pick_amount(t, balance.min(200_000_000_000));
        let expect = if m.pending_redeem[u].is_some() {
            Expect::Code(ACCOUNT_ALREADY_IN_USE)
        } else if amount == 0 {
            mint_err("InvalidAmount")
        } else if amount > balance {
            mint_err("InsufficientBalance")
        } else {
            Expect::Ok
        };
        let ix = m
            .world
            .mint_call_for("request_redeem", u)
            .with_args(&amount)
            .instruction();
        if run(t, ix, "request_redeem", expect) {
            m.pending_redeem[u] = Some(amount);
        }
    }

    #[flow]
    fn cancel_redeem(&mut self) {
        let (t, m) = (&mut self.trident, self.fuzz_accounts.as_mut().unwrap());
        let u = t.random_from_range(0..USERS);
        let expect = match m.pending_redeem[u] {
            Some(_) => Expect::Ok,
            None => Expect::Code(ANCHOR_ACCOUNT_NOT_INITIALIZED),
        };
        let ix = m.world.mint_call_for("cancel_redeem", u).instruction();
        if run(t, ix, "cancel_redeem", expect) {
            m.pending_redeem[u] = None;
        }
    }

    #[flow]
    fn fund_redeem_vault(&mut self) {
        let (t, m) = (&mut self.trident, self.fuzz_accounts.as_mut().unwrap());
        let amount = t.random_from_range(1..=100_000_000_000u64);
        m.world.mint_usdc(t, m.world.redeem_vault, amount);
        m.usdc_minted += amount;
    }

    #[flow]
    fn complete_redeem(&mut self) {
        let (t, m) = (&mut self.trident, self.fuzz_accounts.as_mut().unwrap());
        let u = t.random_from_range(0..USERS);
        let user = &m.world.users[u];
        let request = m
            .world
            .mint_call_for("complete_redeem", u)
            .account("redemption_request");
        let watched = [
            user.wylds,
            user.usdc,
            m.world.redeem_vault,
            m.world.wylds_mint,
            request,
        ];
        let before = snapshot(t, &watched);
        let wylds = token_balance(t, user.wylds);
        let usdc = token_balance(t, user.usdc);
        let vault = token_balance(t, m.world.redeem_vault);

        let (approved, expect) = match m.pending_redeem[u] {
            None => (1, Expect::Code(ANCHOR_ACCOUNT_NOT_INITIALIZED)),
            Some(amount) => {
                let approved = if t.random_from_range(0..8u8) == 0 {
                    amount + 1
                } else {
                    amount
                };
                let expect = if approved != amount {
                    mint_err("RedemptionAmountMismatch")
                } else if wylds < amount {
                    mint_err("InsufficientRedemptionBalance")
                } else if vault < amount {
                    mint_err("InsufficientVaultBalance")
                } else {
                    Expect::Ok
                };
                (approved, expect)
            }
        };
        let short_vault = matches!(m.pending_redeem[u], Some(a) if vault < a);
        let ix = m
            .world
            .mint_call_for("complete_redeem", u)
            .with_args(&approved)
            .instruction();
        let label = if short_vault {
            "complete_redeem short vault"
        } else {
            "complete_redeem"
        };
        if run(t, ix, label, expect) {
            let amount = m.pending_redeem[u].take().unwrap();
            assert_eq!(token_balance(t, user.wylds), wylds - amount);
            assert_eq!(token_balance(t, user.usdc), usdc + amount);
            assert_eq!(token_balance(t, m.world.redeem_vault), vault - amount);
            assert_eq!(t.get_account(&request).lamports(), 0, "request closed");
        } else {
            assert_eq!(
                snapshot(t, &watched),
                before,
                "failed complete_redeem changed state"
            );
        }
    }

    #[flow]
    fn sweep(&mut self) {
        let (t, m) = (&mut self.trident, self.fuzz_accounts.as_mut().unwrap());
        let vault = token_balance(t, m.world.redeem_vault);
        let treasury = token_balance(t, m.world.mint_vault);
        let amount = pick_amount(t, vault);
        let expect = if amount == 0 {
            mint_err("InvalidAmount")
        } else if amount > vault {
            mint_err("InsufficientRedeemVaultFunds")
        } else {
            Expect::Ok
        };
        let ix = m
            .world
            .call(Program::Mint, "sweep_redeem_vault_funds")
            .with_args(&amount)
            .instruction();
        let swept = if run(t, ix, "sweep", expect) {
            amount
        } else {
            0
        };
        assert_eq!(token_balance(t, m.world.redeem_vault), vault - swept);
        assert_eq!(token_balance(t, m.world.mint_vault), treasury + swept);
    }

    #[flow]
    fn register_external_program(&mut self) {
        let (t, m) = (&mut self.trident, self.fuzz_accounts.as_mut().unwrap());
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
        if run(t, ix, "register_external_program", expect) && !m.allowed.contains(&program) {
            m.allowed.push(program);
        }
        assert_eq!(allowed_programs(t, &m.world), m.allowed);
    }

    #[flow]
    fn update_external_program_limit(&mut self) {
        let (t, m) = (&mut self.trident, self.fuzz_accounts.as_mut().unwrap());
        let limit = t.random_from_range(0..=EXECUTABLES.len() as u8 + 2);
        let ix = m
            .world
            .call(Program::Mint, "update_external_mint_programs_limit")
            .with_args(&limit)
            .instruction();
        run(t, ix, "update_external_program_limit", Expect::Ok);
        m.limit = limit;
    }

    #[flow]
    fn external_program_mint(&mut self) {
        let (t, m) = (&mut self.trident, self.fuzz_accounts.as_mut().unwrap());
        let program = candidate(t, &m.world);
        let u = t.random_from_range(0..USERS);
        let amount = t.random_from_range(1..=1_000_000_000u64);
        let expect = if program == m.world.wylds_mint {
            Expect::Code(ANCHOR_CONSTRAINT_EXECUTABLE)
        } else if program == stake_id() || m.allowed.contains(&program) {
            Expect::Ok
        } else {
            mint_err("InvalidMintProgramCaller")
        };
        let destination = m.world.users[u].wylds;
        let before = token_balance(t, destination);
        let ix = m
            .world
            .mint_call_for("external_program_mint", u)
            .with("calling_program", program)
            .with_args(&amount)
            .instruction();
        let minted = if run(t, ix, "external_program_mint", expect) {
            amount
        } else {
            0
        };
        assert_eq!(token_balance(t, destination), before + minted);
    }

    #[flow]
    fn stake_price_report(&mut self) {
        let (t, m) = (&mut self.trident, self.fuzz_accounts.as_mut().unwrap());
        let now = pin_clock(t, m);
        let random = now - t.random_from_range(-2..=PRICE_MAX_STALENESS);
        let observed = edge_or(t, &[now, now + 1, m.price_ts, m.price_ts + 1], random);
        let random = observed - t.random_from_range(-1..=10i64);
        let valid_from = edge_or(t, &[now, now + 1, observed, observed + 1], random);
        let random = now + t.random_from_range(-2..=120i64);
        let expires_at = edge_or(t, &[now, now - 1, observed, observed - 1], random);
        let feed = if t.random_from_range(0..10u8) == 0 {
            [8; 32]
        } else {
            FEED_ID
        };
        let price = pick_price(t);

        let expect = if now < valid_from {
            stake_err("FutureReportValidFromTimestamp")
        } else if now > expires_at {
            stake_err("ReportStale")
        } else if feed != FEED_ID {
            stake_err("InvalidFeedId")
        } else if !(valid_from <= observed && observed <= expires_at) {
            stake_err("InvalidReportTimestamps")
        } else if observed > now {
            stake_err("FutureObservationTimestamp")
        } else if observed <= m.price_ts {
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
            .with_args(&report)
            .instruction();
        if run(t, ix, "stake_price_report", expect) {
            m.price = price;
            m.price_ts = observed;
        }
    }

    #[flow]
    fn stake_deposit(&mut self) {
        let (t, m) = (&mut self.trident, self.fuzz_accounts.as_mut().unwrap());
        let u = t.random_from_range(0..USERS);
        let user = &m.world.users[u];
        let wylds = token_balance(t, user.wylds);
        let prime = token_balance(t, user.prime);
        let vault = token_balance(t, m.world.stake_vault);
        let supply = mint_supply(t, m.world.prime_mint);
        let amount = pick_amount(t, wylds);
        let now = pin_clock(t, m);

        let shares = mul_div(amount, PRICE_SCALE as u128, m.price);
        let expect = if amount == 0 {
            stake_err("InvalidAmount")
        } else if let Some(err) = price_error(m, now) {
            err
        } else {
            match shares {
                None => stake_err("Overflow"),
                Some(0) => stake_err("DepositTooSmall"),
                Some(_) if amount > wylds => Expect::Code(SPL_INSUFFICIENT_FUNDS),
                Some(s) if supply.checked_add(s).is_none() => Expect::Code(SPL_OVERFLOW),
                Some(_) => Expect::Ok,
            }
        };
        let ix = m
            .world
            .stake_call_for("deposit", u)
            .with_args(&amount)
            .instruction();
        let label = stake_label("stake_deposit", m, now);
        if run(t, ix, &label, expect) {
            let shares = shares.unwrap();
            assert_eq!(token_balance(t, user.wylds), wylds - amount);
            assert_eq!(token_balance(t, user.prime), prime + shares);
            assert_eq!(token_balance(t, m.world.stake_vault), vault + amount);
        }
    }

    #[flow]
    fn stake_redeem(&mut self) {
        let (t, m) = (&mut self.trident, self.fuzz_accounts.as_mut().unwrap());
        let u = t.random_from_range(0..USERS);
        let user = &m.world.users[u];
        let wylds = token_balance(t, user.wylds);
        let prime = token_balance(t, user.prime);
        let vault = token_balance(t, m.world.stake_vault);
        let shares = pick_amount(t, prime);
        let now = pin_clock(t, m);

        let assets = mul_div(shares, m.price.max(0) as u128, PRICE_SCALE as i128);
        let expect = if shares == 0 {
            stake_err("InvalidAmount")
        } else if let Some(err) = price_error(m, now) {
            err
        } else if shares > prime {
            stake_err("InsufficientBalance")
        } else {
            match assets {
                None => stake_err("Overflow"),
                Some(0) => stake_err("InvalidAmount"),
                Some(a) if a > vault => stake_err("InsufficientVaultBalance"),
                Some(_) => Expect::Ok,
            }
        };
        let ix = m
            .world
            .stake_call_for("redeem", u)
            .with_args(&shares)
            .instruction();
        let label = stake_label("stake_redeem", m, now);
        if run(t, ix, &label, expect) {
            let assets = assets.unwrap();
            assert_eq!(token_balance(t, user.prime), prime - shares);
            assert_eq!(token_balance(t, user.wylds), wylds + assets);
            assert_eq!(token_balance(t, m.world.stake_vault), vault - assets);
        }
    }

    /// Deposits, then redeems exactly the minted shares at the same price and time. Checked from
    /// observed balances only, so it does not rely on the model's conversion formula.
    #[flow]
    fn stake_round_trip(&mut self) {
        let (t, m) = (&mut self.trident, self.fuzz_accounts.as_mut().unwrap());
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
        let (t, m) = (&mut self.trident, self.fuzz_accounts.as_mut().unwrap());
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
        let record = pda(
            &[b"reward_record", &id.to_le_bytes(), &amount.to_le_bytes()],
            &stake_id(),
        );
        let expect = if t.get_account(&record).lamports() > 0 {
            // Replaying a published (id, amount) fails creating its record.
            Expect::Code(ACCOUNT_ALREADY_IN_USE)
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
        } else {
            Expect::Ok
        };
        let ix = m
            .world
            .call(Program::Stake, "publish_rewards")
            .with("reward_record", record)
            .with_args(&(id, amount))
            .instruction();
        let published = run(t, ix, "publish_rewards", expect);
        assert_eq!(
            token_balance(t, m.world.stake_vault),
            vault + if published { amount } else { 0 }
        );
        if published {
            let r = &mut m.rewards;
            r.last_id = id;
            r.last_at = now;
            r.distributed += amount;
            assert!(r.distributed <= r.lifetime_cap);
        }
    }

    #[flow]
    fn stake_reward_config_update(&mut self) {
        let (t, m) = (&mut self.trident, self.fuzz_accounts.as_mut().unwrap());
        let r = &mut m.rewards;
        let call = |name| m.world.call(Program::Stake, name);
        match t.random_from_range(0..4u8) {
            0 => {
                let bps = t.random_from_range(0..=MAX_BPS + 1);
                let ok = bps > 0 && bps <= MAX_BPS;
                let expect = if ok {
                    Expect::Ok
                } else {
                    stake_err("InvalidMaxRewardBps")
                };
                run(
                    t,
                    call("update_max_reward_bps").with_args(&bps).instruction(),
                    "update_max_reward_bps",
                    expect,
                );
                if ok {
                    r.bps = bps;
                }
            }
            1 => {
                let cap = t.random_from_range(0..=5_000_000_000u64);
                let expect = if cap > 0 {
                    Expect::Ok
                } else {
                    stake_err("InvalidMaxPeriodRewards")
                };
                let ix = call("update_max_period_rewards")
                    .with_args(&cap)
                    .instruction();
                if run(t, ix, "update_max_period_rewards", expect) {
                    r.period_cap = cap;
                }
            }
            2 => {
                let seconds = t.random_from_range(-1..=600i64);
                let expect = if seconds > 0 {
                    Expect::Ok
                } else {
                    stake_err("InvalidRewardPeriodSeconds")
                };
                let ix = call("update_reward_period_seconds")
                    .with_args(&seconds)
                    .instruction();
                if run(t, ix, "update_reward_period_seconds", expect) {
                    r.period_seconds = seconds;
                }
            }
            _ => {
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
                if run(t, ix, "update_max_total_rewards", expect) {
                    r.lifetime_cap = cap;
                }
            }
        }
    }

    /// Moves the clock forward, often onto the price staleness or reward cooldown boundary.
    #[flow]
    fn warp(&mut self) {
        let (t, m) = (&mut self.trident, self.fuzz_accounts.as_mut().unwrap());
        let now = m.now;
        let stale_at = m.price_ts + PRICE_MAX_STALENESS;
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
        let (t, m) = (&mut self.trident, self.fuzz_accounts.as_mut().unwrap());
        let w = &m.world;
        let wylds: u64 = w
            .users
            .iter()
            .map(|u| token_balance(t, u.wylds))
            .sum::<u64>()
            + token_balance(t, w.stake_vault);
        assert_eq!(
            mint_supply(t, w.wylds_mint),
            wylds,
            "wYLDS supply equals holdings"
        );
        let prime: u64 = w.users.iter().map(|u| token_balance(t, u.prime)).sum();
        assert_eq!(
            mint_supply(t, w.prime_mint),
            prime,
            "PRIME supply equals holdings"
        );
        let usdc: u64 = w
            .users
            .iter()
            .map(|u| token_balance(t, u.usdc))
            .sum::<u64>()
            + token_balance(t, w.mint_vault)
            + token_balance(t, w.redeem_vault);
        assert_eq!(usdc, m.usdc_minted, "USDC is conserved");
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
            assert!(
                claimed <= epoch.total,
                "epoch {} exceeded its cap",
                epoch.index
            );
        }
    }
}

/// TridentSVM adds elapsed wall-clock time to the Clock after every transaction, so time-sensitive
/// flows reset it to the model's time right before their call.
fn pin_clock(t: &mut Trident, m: &Model) -> i64 {
    t.warp_to_timestamp(m.now);
    m.now
}

/// Mirrors the stored-price checks of deposit and redeem.
fn price_error(m: &Model, now: i64) -> Option<Expect> {
    if now - m.price_ts > PRICE_MAX_STALENESS {
        Some(stake_err("PriceTooStale"))
    } else if m.price <= 0 {
        Some(stake_err("PriceNotInitialized"))
    } else {
        None
    }
}

/// `value * mul / div` narrowed to u64; `None` on overflow or a non-positive divisor.
fn mul_div(value: u64, mul: u128, div: i128) -> Option<u64> {
    if div <= 0 {
        return None;
    }
    u64::try_from((value as u128).checked_mul(mul)? / div as u128).ok()
}

fn stake_label(flow: &str, m: &Model, now: i64) -> String {
    let age = now - m.price_ts;
    let tag = if age == PRICE_MAX_STALENESS {
        " at staleness boundary"
    } else if age == PRICE_MAX_STALENESS + 1 {
        " one second stale"
    } else {
        ""
    };
    format!("{flow}{tag}")
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

fn pick_price(t: &mut Trident) -> i128 {
    match t.random_from_range(0..10u8) {
        0 => -t.random_from_range(0..=i128::MAX),
        1 => 0,
        2 => 1,
        // Log-uniform over the whole positive range, so every magnitude is reached.
        3 | 4 => {
            let bits = t.random_from_range(0..127u32);
            (1i128 << bits) | (t.random_from_range(0..=i128::MAX) & ((1i128 << bits) - 1))
        }
        _ => t.random_from_range(PRICE_SCALE as i128 / 2..=PRICE_SCALE as i128 * 2),
    }
}

/// Half the time one of the boundary values a check compares against, otherwise `random`.
fn edge_or(t: &mut Trident, edges: &[i64], random: i64) -> i64 {
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

fn snapshot(t: &mut Trident, keys: &[Pubkey]) -> Vec<(u64, Vec<u8>)> {
    keys.iter()
        .map(|k| {
            let a = t.get_account(k);
            (a.lamports(), a.data().to_vec())
        })
        .collect()
}
fn main() {
    let env = |name: &str, default: u64| {
        std::env::var(name)
            .ok()
            .map_or(default, |v| v.parse().unwrap())
    };
    FuzzTest::fuzz(env("FUZZ_ITERATIONS", 200), env("FUZZ_FLOWS", 60));
}
