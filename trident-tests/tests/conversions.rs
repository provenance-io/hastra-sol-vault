//! Share/asset conversions at extreme amounts, prices and price scales, run through the compiled
//! vault-stake program: `deposit`, `redeem` and the `assets_to_shares` / `shares_to_assets` views.
//! The price config and token balances are written directly, so every case starts from a fresh,
//! unconstrained world (empty PRIME supply, no balance that could overflow).

use hastra_fuzz::world::*;
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
}

impl Ix {
    fn name(self) -> &'static str {
        match self {
            Ix::Deposit => "deposit",
            Ix::Redeem => "redeem",
            Ix::AssetsToShares => "assets_to_shares",
            Ix::SharesToAssets => "shares_to_assets",
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

/// Value logged by the views (`... = <value> shares|assets`).
fn view_value(logs: &str) -> u64 {
    let line = logs
        .lines()
        .find(|l| l.contains("assets_to_shares:") || l.contains("shares_to_assets:"))
        .expect("view logs its result");
    line.rsplit(' ').nth(1).unwrap().parse().unwrap()
}

fn run(ix: Ix, amount: u64, price: i128, scale: u64) -> Raw {
    let mut trident = Trident::default();
    let world = World::ready(&mut trident, 1);
    let user = &world.users[0];
    let now = START_TIME + 10;
    trident.warp_to_timestamp(now);

    let config = world
        .call(Program::Stake, "deposit")
        .account("stake_price_config");
    patch(&mut trident, config, PRICE, &price.to_le_bytes());
    patch(&mut trident, config, PRICE_SCALE_AT, &scale.to_le_bytes());
    patch(&mut trident, config, PRICE_TIMESTAMP, &now.to_le_bytes());
    let (wylds, prime, vault, supply) = match ix {
        Ix::Deposit => (amount, 0, 0, 0),
        _ => (0, amount, M, amount),
    };
    patch(&mut trident, user.wylds, TOKEN_AMOUNT, &wylds.to_le_bytes());
    patch(&mut trident, user.prime, TOKEN_AMOUNT, &prime.to_le_bytes());
    patch(
        &mut trident,
        world.stake_vault,
        TOKEN_AMOUNT,
        &vault.to_le_bytes(),
    );
    patch(
        &mut trident,
        world.prime_mint,
        MINT_SUPPLY,
        &supply.to_le_bytes(),
    );

    let call = match ix {
        Ix::Deposit | Ix::Redeem => world.stake_call_for(ix.name(), 0),
        _ => world.call(Program::Stake, ix.name()),
    };
    let result = trident.process_transaction(&[call.with_args(&amount).instruction()], None);
    if !result.is_success() {
        let name = match result.get_custom_error_code() {
            Some(code) => stake_idl().error_name(code).map(str::to_string),
            None => None,
        };
        let name = name.unwrap_or_else(|| format!("{:?}", result.get_result()));
        return Err(name.leak());
    }
    match ix {
        Ix::AssetsToShares | Ix::SharesToAssets => Ok(view_value(&result.logs())),
        Ix::Deposit => {
            assert_eq!(token_balance(&mut trident, user.wylds), 0);
            assert_eq!(token_balance(&mut trident, world.stake_vault), amount);
            Ok(token_balance(&mut trident, user.prime))
        }
        Ix::Redeem => {
            assert_eq!(token_balance(&mut trident, user.prime), 0);
            let paid = token_balance(&mut trident, user.wylds);
            assert_eq!(token_balance(&mut trident, world.stake_vault), M - paid);
            Ok(paid)
        }
    }
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
            let got = run(ix, amount, price, scale);
            if got != expected {
                problems.push(format!(
                    "{ix:?} amount {amount} price {price} scale {scale}: expected {expected:?}, got {got:?}"
                ));
            }
        }
    }
    assert!(problems.is_empty(), "{}", problems.join("\n"));
}
