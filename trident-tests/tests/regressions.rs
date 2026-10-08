//! Counterexamples found by `fuzz_vault`, kept as plain tests.

use hastra_fuzz::world::*;
use trident_fuzz::fuzzing::*;

const SPL_TOKEN_OVERFLOW: u32 = 14;

/// At a price of 1 (1e-9 wYLDS per PRIME) a deposit can mint a share amount that fits in u64 but
/// overflows the PRIME supply; SPL Token rejects the mint and every balance stays unchanged.
#[test]
fn deposit_overflowing_prime_supply_fails_cleanly() {
    let mut trident = Trident::default();
    let world = World::ready(&mut trident, 1);
    trident.warp_to_timestamp(START_TIME + 1);
    world.publish_price(&mut trident, 1);
    let user = &world.users[0];

    let supply = mint_supply(&mut trident, world.prime_mint);
    let amount: u64 = 18_446_744_000;
    let shares = amount as u128 * PRICE_SCALE as u128;
    assert!(shares <= u64::MAX as u128 && shares + supply as u128 > u64::MAX as u128);

    let watched = [user.wylds, user.prime, world.stake_vault, world.prime_mint];
    let before: Vec<_> = watched.iter().map(|k| trident.get_account(k)).collect();
    let deposit = world
        .stake_call_for("deposit", 0)
        .with_args(&amount)
        .instruction();
    let result = trident.process_transaction(&[deposit], None);
    assert_eq!(
        result.get_custom_error_code(),
        Some(SPL_TOKEN_OVERFLOW),
        "{}",
        result.logs()
    );
    let after: Vec<_> = watched.iter().map(|k| trident.get_account(k)).collect();
    assert_eq!(before, after);

    let small = world
        .stake_call_for("deposit", 0)
        .with_args(&1_000u64)
        .instruction();
    ok(
        &mut trident,
        small,
        "deposit at price 1 that fits the supply",
    );
}
