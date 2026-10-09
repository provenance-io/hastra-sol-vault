//! Share/asset conversions run through the compiled vault-stake program: `deposit`, `redeem`
//! and the `assets_to_shares` / `shares_to_assets` / `exchange_rate` views. A hand-worked table
//! covers the extremes, and property tests cover amounts, prices and price scales drawn
//! log-uniformly from their full ranges. The price config and token balances are rewritten before every call, so each call
//! starts unconstrained (empty PRIME supply, no balance that could overflow).

use hastra_fuzz::world::*;
use proptest::prelude::*;
use std::cell::RefCell;
use trident_fuzz::fuzzing::*;

const M: u64 = u64::MAX;
const P: i128 = i128::MAX;

// StakePriceConfig: discriminator, three pubkeys and the feed id, then these fields.
const PRICE: usize = 136;
const PRICE_SCALE_AT: usize = 152;
const PRICE_TIMESTAMP: usize = 160;
const TOKEN_AMOUNT: usize = 64;
const MINT_SUPPLY: usize = 36;

/// Raw arithmetic with no zero-result checks: `Ok(value)` or the error the u128 math raises.
type Raw = Result<u64, &'static str>;

/// (amount, price, scale, amount * scale / price, amount * price / scale), worked by hand.
#[rustfmt::skip]
const TABLE: [(u64, i128, u64, Raw, Raw); 27] = [
    (0, 1, 0, Ok(0), Err("DivisionByZero")),
    (0, 1, 1, Ok(0), Ok(0)),
    (0, 1, M, Ok(0), Ok(0)),
    (1, 1, 0, Ok(0), Err("DivisionByZero")),
    (1, 1, 1, Ok(1), Ok(1)),
    (1, 1, M, Ok(M), Ok(0)),
    (M, 1, 0, Ok(0), Err("DivisionByZero")),
    (M, 1, 1, Ok(M), Ok(M)),
    (M, 1, M, Err("Overflow"), Ok(1)),
    (0, M as i128, 0, Ok(0), Err("DivisionByZero")),
    (0, M as i128, 1, Ok(0), Ok(0)),
    (0, M as i128, M, Ok(0), Ok(0)),
    (1, M as i128, 0, Ok(0), Err("DivisionByZero")),
    (1, M as i128, 1, Ok(0), Ok(M)),
    (1, M as i128, M, Ok(1), Ok(1)),
    (M, M as i128, 0, Ok(0), Err("DivisionByZero")),
    (M, M as i128, 1, Ok(1), Err("Overflow")),
    (M, M as i128, M, Ok(M), Ok(M)),
    (0, P, 0, Ok(0), Err("DivisionByZero")),
    (0, P, 1, Ok(0), Ok(0)),
    (0, P, M, Ok(0), Ok(0)),
    (1, P, 0, Ok(0), Err("DivisionByZero")),
    (1, P, 1, Ok(0), Err("Overflow")),
    // (2^127 - 1) / (2^64 - 1) = 2^63 remainder 2^63 - 1.
    (1, P, M, Ok(0), Ok(1 << 63)),
    // amount * price overflows u128 before the division is reached.
    (M, P, 0, Ok(0), Err("Overflow")),
    (M, P, 1, Ok(0), Err("Overflow")),
    // (2^64 - 1)^2 is just under 2 * (2^127 - 1).
    (M, P, M, Ok(1), Err("Overflow")),
];

#[derive(Clone, Copy, Debug, PartialEq)]
enum Ix {
    Deposit,
    Redeem,
    AssetsToShares,
    SharesToAssets,
    ExchangeRate,
}

impl Ix {
    fn name(self) -> &'static str {
        match self {
            Ix::Deposit => "deposit",
            Ix::Redeem => "redeem",
            Ix::AssetsToShares => "assets_to_shares",
            Ix::SharesToAssets => "shares_to_assets",
            Ix::ExchangeRate => "exchange_rate",
        }
    }

    /// The program's checks in order: zero amount (deposit/redeem only), then a non-positive
    /// price, then the arithmetic, then a zero result (deposit/redeem only).
    fn expect(self, amount: u64, price: i128, raw: Raw) -> Raw {
        let moves_funds = matches!(self, Ix::Deposit | Ix::Redeem);
        if moves_funds && amount == 0 {
            return Err("InvalidAmount");
        }
        if price <= 0 {
            return Err("PriceNotInitialized");
        }
        match (self, raw) {
            (Ix::Deposit, Ok(0)) => Err("DepositTooSmall"),
            (Ix::Redeem, Ok(0)) => Err("InvalidAmount"),
            _ => raw,
        }
    }
}

fn patch(trident: &mut Trident, key: Pubkey, offset: usize, bytes: &[u8]) {
    let mut account = trident.get_account(&key);
    account.data_as_mut_slice()[offset..offset + bytes.len()].copy_from_slice(bytes);
    trident.set_account_custom(&key, &account);
}

/// One set-up world whose price config and balances are overwritten before each call.
struct Bench {
    trident: Trident,
    world: World,
    config: Pubkey,
}

const NOW: i64 = START_TIME + 10;

impl Bench {
    fn new() -> Self {
        let mut trident = Trident::default();
        let world = World::ready(&mut trident, 1);
        let config = world
            .call(Program::Stake, "deposit")
            .account("stake_price_config");
        Self {
            trident,
            world,
            config,
        }
    }

    fn set_price(&mut self, price: i128, scale: u64) {
        let t = &mut self.trident;
        t.warp_to_timestamp(NOW);
        patch(t, self.config, PRICE, &price.to_le_bytes());
        patch(t, self.config, PRICE_SCALE_AT, &scale.to_le_bytes());
        patch(t, self.config, PRICE_TIMESTAMP, &NOW.to_le_bytes());
    }

    fn set_balances(&mut self, wylds: u64, prime: u64, vault: u64, prime_supply: u64) {
        let t = &mut self.trident;
        let user = &self.world.users[0];
        patch(t, user.wylds, TOKEN_AMOUNT, &wylds.to_le_bytes());
        patch(t, user.prime, TOKEN_AMOUNT, &prime.to_le_bytes());
        patch(
            t,
            self.world.stake_vault,
            TOKEN_AMOUNT,
            &vault.to_le_bytes(),
        );
        patch(
            t,
            self.world.prime_mint,
            MINT_SUPPLY,
            &prime_supply.to_le_bytes(),
        );
    }

    fn balances(&mut self) -> (u64, u64, u64) {
        let user = &self.world.users[0];
        let (wylds, prime) = (user.wylds, user.prime);
        let t = &mut self.trident;
        (
            token_balance(t, wylds),
            token_balance(t, prime),
            token_balance(t, self.world.stake_vault),
        )
    }

    /// Calls `ix` with the current state; returns shares minted, assets paid or the view's value.
    /// `exchange_rate` takes no amount.
    fn call(&mut self, ix: Ix, amount: u64) -> Raw {
        let call = match ix {
            Ix::Deposit | Ix::Redeem => self.world.stake_call_for(ix.name(), 0),
            _ => self.world.call(Program::Stake, ix.name()),
        };
        let call = match ix {
            Ix::ExchangeRate => call,
            _ => call.with_args(&amount),
        };
        let before = self.balances();
        let result = self
            .trident
            .process_transaction(&[call.instruction()], None);
        if !result.is_success() {
            let name = result
                .get_custom_error_code()
                .and_then(|code| stake_idl().error_name(code));
            return Err(name.unwrap_or_else(|| format!("{:?}", result.get_result()).leak()));
        }
        let (wylds, prime, vault) = self.balances();
        match ix {
            Ix::AssetsToShares | Ix::SharesToAssets | Ix::ExchangeRate => {
                Ok(view_value(&result.logs(), ix.name()))
            }
            Ix::Deposit => {
                assert_eq!(wylds, before.0 - amount);
                assert_eq!(vault, before.2 + amount);
                Ok(prime - before.1)
            }
            Ix::Redeem => {
                assert_eq!(prime, before.1 - amount);
                assert_eq!(before.2 - vault, wylds - before.0);
                Ok(wylds - before.0)
            }
        }
    }

    /// Runs `ix` on `amount` with fresh balances that cannot limit the result; for
    /// `exchange_rate`, `amount` is only the PRIME supply.
    fn run(&mut self, ix: Ix, amount: u64, price: i128, scale: u64) -> Raw {
        self.set_price(price, scale);
        match ix {
            Ix::Deposit => self.set_balances(amount, 0, 0, 0),
            _ => self.set_balances(0, amount, M, amount),
        }
        self.call(ix, amount)
    }
}

thread_local! {
    static BENCH: RefCell<Bench> = RefCell::new(Bench::new());
}

fn with_bench<T>(f: impl FnOnce(&mut Bench) -> T) -> T {
    BENCH.with(|b| f(&mut b.borrow_mut()))
}

#[test]
fn conversions_at_extremes() {
    let mut cases: Vec<(u64, i128, u64, Raw, Raw)> = TABLE.to_vec();
    for price in [i128::MIN, -1, 0] {
        for amount in [0, 1, M] {
            for scale in [0, 1, M] {
                cases.push((amount, price, scale, Ok(0), Ok(0)));
            }
        }
    }
    let mut problems = Vec::new();
    for (amount, price, scale, to_shares, to_assets) in cases {
        for (ix, raw) in [
            (Ix::Deposit, to_shares),
            (Ix::AssetsToShares, to_shares),
            (Ix::Redeem, to_assets),
            (Ix::SharesToAssets, to_assets),
        ] {
            let expected = ix.expect(amount, price, raw);
            let got = with_bench(|b| b.run(ix, amount, price, scale));
            if got != expected {
                problems.push(format!(
                    "{ix:?} amount {amount} price {price} scale {scale}: expected {expected:?}, got {got:?}"
                ));
            }
        }
    }
    assert!(problems.is_empty(), "{}", problems.join("\n"));
}

/// `numerator / denominator` narrowed to u64, judged only by the defining inequalities of floor
/// division; `numerator` is `None` when it exceeds u128. The program multiplies before dividing,
/// so an oversized numerator is `Overflow` even when the denominator is zero.
fn check_floor(numerator: Option<u128>, denominator: u128, got: Raw) -> Result<(), String> {
    let expected_err = match numerator {
        None => Some("Overflow"),
        Some(_) if denominator == 0 => Some("DivisionByZero"),
        Some(n) => (1u128 << 64)
            .checked_mul(denominator)
            .is_some_and(|limit| n >= limit)
            .then_some("Overflow"),
    };
    match (expected_err, got) {
        (Some(e), Err(g)) if e == g => Ok(()),
        (None, Ok(r)) => {
            let n = numerator.unwrap();
            let low = (r as u128).checked_mul(denominator).is_some_and(|v| v <= n);
            let high = (r as u128 + 1)
                .checked_mul(denominator)
                .is_none_or(|v| v > n);
            if low && high {
                Ok(())
            } else {
                Err(format!("{r} is not floor({n} / {denominator})"))
            }
        }
        (e, g) => Err(format!("expected {e:?}, got {g:?}")),
    }
}

/// 0, `u64::MAX`, or a value whose bit length is uniform in 1..=64.
fn wide_u64() -> impl Strategy<Value = u64> {
    prop_oneof![
        1 => Just(0),
        1 => Just(M),
        8 => (0u32..64, any::<u64>()).prop_map(|(bits, r)| (1u64 << bits) | (r & ((1u64 << bits) - 1))),
    ]
}

/// A positive price whose bit length is uniform in 1..=127.
fn positive_price() -> impl Strategy<Value = i128> {
    (0u32..127, any::<i128>()).prop_map(|(bits, r)| (1i128 << bits) | (r & ((1i128 << bits) - 1)))
}

/// Any i128 (half are non-positive), zero, or a positive price of any magnitude.
fn wide_price() -> impl Strategy<Value = i128> {
    prop_oneof![1 => any::<i128>(), 1 => Just(0), 8 => positive_price()]
}

// Case count and seed come from PROPTEST_CASES / PROPTEST_RNG_SEED (CI pins both on PRs).
proptest! {
    #[test]
    fn views_are_exact_floor(amount in wide_u64(), price in wide_price(), scale in wide_u64()) {
        let (shares, assets) = with_bench(|b| {
            (b.run(Ix::AssetsToShares, amount, price, scale), b.run(Ix::SharesToAssets, amount, price, scale))
        });
        if price <= 0 {
            prop_assert_eq!(shares, Err("PriceNotInitialized"));
            prop_assert_eq!(assets, Err("PriceNotInitialized"));
        } else {
            let to_shares = Some(amount as u128 * scale as u128);
            let to_assets = (amount as u128).checked_mul(price as u128);
            check_floor(to_shares, price as u128, shares).map_err(|e| TestCaseError::fail(format!("assets_to_shares: {e}")))?;
            check_floor(to_assets, scale as u128, assets).map_err(|e| TestCaseError::fail(format!("shares_to_assets: {e}")))?;
        }
    }

    #[test]
    fn deposit_and_redeem_agree_with_views(amount in wide_u64(), price in wide_price(), scale in wide_u64()) {
        with_bench(|b| {
            for (ix, view) in [(Ix::Deposit, Ix::AssetsToShares), (Ix::Redeem, Ix::SharesToAssets)] {
                let raw = b.run(view, amount, price, scale);
                let raw = if price <= 0 { Ok(0) } else { raw };
                prop_assert_eq!(b.run(ix, amount, price, scale), ix.expect(amount, price, raw), "{:?}", ix);
            }
            Ok(())
        })?;
    }

    /// The rate is the value of `EXCHANGE_RATE_SCALE` shares, floored, whatever the PRIME supply.
    #[test]
    fn exchange_rate_is_the_value_of_one_share(supply in wide_u64(), price in wide_price(), scale in wide_u64()) {
        let (rate, value) = with_bench(|b| {
            (b.run(Ix::ExchangeRate, supply, price, scale), b.run(Ix::SharesToAssets, EXCHANGE_RATE_SCALE, price, scale))
        });
        prop_assert_eq!(rate, value);
        if price <= 0 {
            prop_assert_eq!(rate, Err("PriceNotInitialized"));
        } else {
            check_floor((price as u128).checked_mul(EXCHANGE_RATE_SCALE as u128), scale as u128, rate).map_err(TestCaseError::fail)?;
        }
    }

    #[test]
    fn redeeming_a_deposit_never_returns_more(
        amount in wide_u64().prop_map(|a| a.max(1)),
        price in positive_price(),
        scale in wide_u64(),
    ) {
        with_bench(|b| {
            let Ok(shares) = b.run(Ix::Deposit, amount, price, scale) else {
                return Ok(());
            };
            // A vault large enough that only the conversion limits what is paid out.
            b.set_balances(0, shares, M, shares);
            match b.call(Ix::Redeem, shares) {
                Ok(back) => prop_assert!(back <= amount, "deposit {} minted {} shares, redeemed for {}", amount, shares, back),
                Err(e) => prop_assert_eq!(e, "InvalidAmount"),
            }
            Ok(())
        })?;
    }
}
