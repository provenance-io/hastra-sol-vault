//! Price, share and reward-cap arithmetic used by the instruction handlers.
//!
//! Everything here takes plain values (no `Context`, no `AccountInfo`) so the property tests
//! below exercise exactly the code that runs on-chain.

use crate::error::CustomErrorCode;
use crate::state::{LastRewardPublication, StakeRewardConfig};
use anchor_lang::prelude::*;

/// Scale applied by `exchange_rate`: assets per share × 1e9.
pub const EXCHANGE_RATE_SCALE: u64 = 1_000_000_000;

/// Rejects a missing, stale or non-positive stored price.
/// Age is `now - price_timestamp`; a price exactly `max_staleness` seconds old is still accepted.
pub fn require_fresh_price(
    price: i128,
    price_timestamp: i64,
    max_staleness: i64,
    now: i64,
) -> Result<()> {
    require!(price_timestamp > 0, CustomErrorCode::PriceNotInitialized);
    let age = now
        .checked_sub(price_timestamp)
        .ok_or(CustomErrorCode::Overflow)?;
    require!(age <= max_staleness, CustomErrorCode::PriceTooStale);
    require!(price > 0, CustomErrorCode::PriceNotInitialized);
    Ok(())
}

fn positive_price(price: i128) -> Result<u128> {
    require!(price > 0, CustomErrorCode::PriceNotInitialized);
    Ok(price as u128)
}

/// `value * mul / div`, computed in u128 and narrowed back to u64.
fn mul_div(value: u64, mul: u128, div: u128) -> Result<u64> {
    let result = (value as u128)
        .checked_mul(mul)
        .ok_or(CustomErrorCode::Overflow)?
        .checked_div(div)
        .ok_or(CustomErrorCode::DivisionByZero)?;
    u64::try_from(result).map_err(|_| CustomErrorCode::Overflow.into())
}

/// shares = assets * price_scale / price
pub fn assets_to_shares(assets: u64, price: i128, price_scale: u64) -> Result<u64> {
    mul_div(assets, price_scale as u128, positive_price(price)?)
}

/// assets = shares * price / price_scale
pub fn shares_to_assets(shares: u64, price: i128, price_scale: u64) -> Result<u64> {
    mul_div(shares, positive_price(price)?, price_scale as u128)
}

/// Assets per share scaled by `EXCHANGE_RATE_SCALE`: price * 1e9 / price_scale.
pub fn exchange_rate(price: i128, price_scale: u64) -> Result<u64> {
    shares_to_assets(EXCHANGE_RATE_SCALE, price, price_scale)
}

/// Shares minted for a deposit; a deposit that would mint nothing is rejected.
pub fn deposit_shares(amount: u64, price: i128, price_scale: u64) -> Result<u64> {
    let shares = assets_to_shares(amount, price, price_scale)?;
    require!(shares > 0, CustomErrorCode::DepositTooSmall);
    Ok(shares)
}

/// Assets paid out for a redeem; a redeem that would pay nothing is rejected.
pub fn redeem_assets(shares: u64, price: i128, price_scale: u64) -> Result<u64> {
    let assets = shares_to_assets(shares, price, price_scale)?;
    require!(assets > 0, CustomErrorCode::InvalidAmount);
    Ok(assets)
}

/// Publication ids must strictly increase by at most `LastRewardPublication::MAX_GAP`.
pub fn check_publication_id(last_id: u32, id: u32) -> Result<()> {
    require!(
        id > last_id,
        CustomErrorCode::RewardPublicationIdNotMonotonic
    );
    let gap = id.checked_sub(last_id).ok_or(CustomErrorCode::Overflow)?;
    require!(
        gap <= LastRewardPublication::MAX_GAP,
        CustomErrorCode::RewardPublicationIdGapTooLarge
    );
    Ok(())
}

/// Applies the reward caps and cooldown to a proposed `publish_rewards` amount, returning the new
/// lifetime total. The bps cap is skipped only while the vault is empty (bootstrap), and the
/// cooldown only before the first publication.
pub fn check_reward_limits(
    config: &StakeRewardConfig,
    total_assets: u64,
    amount: u64,
    now: i64,
) -> Result<u64> {
    if total_assets > 0 {
        let max_allowed = (total_assets as u128)
            .checked_mul(config.max_reward_bps as u128)
            .and_then(|v| v.checked_div(StakeRewardConfig::MAX_BPS as u128))
            .and_then(|v| u64::try_from(v).ok())
            .ok_or(CustomErrorCode::Overflow)?;
        require!(
            amount <= max_allowed,
            CustomErrorCode::RewardExceedsMaxDelta
        );
    }

    require!(
        amount <= config.max_period_rewards,
        CustomErrorCode::ExceedsPeriodRewardCap
    );

    if config.last_reward_distributed_at > 0 {
        let next_allowed_at = config
            .last_reward_distributed_at
            .checked_add(config.reward_period_seconds)
            .ok_or(CustomErrorCode::Overflow)?;
        require!(
            now >= next_allowed_at,
            CustomErrorCode::RewardCooldownNotElapsed
        );
    }

    let next_total = config
        .total_rewards_distributed
        .checked_add(amount)
        .ok_or(CustomErrorCode::Overflow)?;
    require!(
        next_total <= config.max_total_rewards,
        CustomErrorCode::ExceedsLifetimeRewardCap
    );
    Ok(next_total)
}

pub fn validate_max_reward_bps(new_bps: u64) -> Result<()> {
    require!(
        new_bps > 0 && new_bps <= StakeRewardConfig::MAX_BPS,
        CustomErrorCode::InvalidMaxRewardBps
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    fn code(e: CustomErrorCode) -> u32 {
        e.into()
    }

    fn err_code<T: std::fmt::Debug>(r: Result<T>) -> u32 {
        match r {
            Err(Error::AnchorError(e)) => e.error_code_number,
            other => panic!("expected an Anchor error, got {other:?}"),
        }
    }

    fn assert_err<T: std::fmt::Debug>(r: Result<T>, expected: CustomErrorCode) {
        assert_eq!(err_code(r), code(expected));
    }

    // Realistic price_scale values span 1 (no decimals) to 1e18; prices span the same range so
    // the generated pairs cover both share-cheaper and share-dearer regimes.
    fn price() -> impl Strategy<Value = i128> {
        1i128..=1_000_000_000_000_000_000_000
    }

    fn scale() -> impl Strategy<Value = u64> {
        1u64..=1_000_000_000_000_000_000
    }

    proptest! {
        #![proptest_config(ProptestConfig {
            cases: 2048,
            failure_persistence: None,
            ..ProptestConfig::default()
        })]

        #[test]
        fn redeem_of_deposit_never_exceeds_deposit(x: u64, p in price(), s in scale()) {
            if let Ok(shares) = deposit_shares(x, p, s) {
                match redeem_assets(shares, p, s) {
                    Ok(assets) => prop_assert!(assets <= x),
                    Err(e) => prop_assert!(
                        err_code::<u64>(Err(e)) == code(CustomErrorCode::InvalidAmount)
                    ),
                }
            }
        }

        #[test]
        fn conversions_never_panic(x: u64, p: i128, s: u64) {
            let _ = assets_to_shares(x, p, s);
            let _ = shares_to_assets(x, p, s);
            let _ = deposit_shares(x, p, s);
            let _ = redeem_assets(x, p, s);
            let _ = exchange_rate(p, s);
        }

        #[test]
        fn non_positive_price_is_rejected(x: u64, p in i128::MIN..=0, s: u64) {
            let not_initialized = code(CustomErrorCode::PriceNotInitialized);
            prop_assert_eq!(err_code(assets_to_shares(x, p, s)), not_initialized);
            prop_assert_eq!(err_code(shares_to_assets(x, p, s)), not_initialized);
            prop_assert_eq!(err_code(deposit_shares(x, p, s)), not_initialized);
            prop_assert_eq!(err_code(redeem_assets(x, p, s)), not_initialized);
            prop_assert_eq!(err_code(exchange_rate(p, s)), not_initialized);
        }

        // Exact result: Ok(v) iff floor(x*mul/div) fits in u64; Overflow otherwise.
        #[test]
        fn shares_to_assets_is_exact_or_overflows(x: u64, p in 1i128..=i128::MAX, s in 1u64..) {
            let result = shares_to_assets(x, p, s);
            match (x as u128).checked_mul(p as u128) {
                None => prop_assert_eq!(err_code(result), code(CustomErrorCode::Overflow)),
                Some(product) => {
                    let exact = product / s as u128;
                    if exact > u64::MAX as u128 {
                        prop_assert_eq!(err_code(result), code(CustomErrorCode::Overflow));
                    } else {
                        prop_assert_eq!(result.unwrap() as u128, exact);
                    }
                }
            }
        }

        #[test]
        fn assets_to_shares_is_exact_or_overflows(x: u64, p in 1i128..=i128::MAX, s: u64) {
            let exact = (x as u128) * (s as u128) / (p as u128);
            let result = assets_to_shares(x, p, s);
            if exact > u64::MAX as u128 {
                prop_assert_eq!(err_code(result), code(CustomErrorCode::Overflow));
            } else {
                prop_assert_eq!(result.unwrap() as u128, exact);
            }
        }

        #[test]
        fn amounts_near_u64_max_overflow_when_price_below_scale(
            k in 0u64..1_000_000,
            p in 1i128..=1_000_000_000,
        ) {
            let x = u64::MAX - k;
            // scale >= 2 * price doubles the amount, which cannot fit in u64.
            let s = (p as u64) * 2;
            prop_assert_eq!(err_code(deposit_shares(x, p, s)), code(CustomErrorCode::Overflow));
            prop_assert_eq!(err_code(redeem_assets(x, s as i128, p as u64)), code(CustomErrorCode::Overflow));
        }

        #[test]
        fn dust_deposit_is_too_small(p in 2i128..=1_000_000_000_000_000_000, s in scale()) {
            // amount * scale < price ⇒ 0 shares.
            let max_dust = ((p - 1) as u128 / s as u128) as u64;
            prop_assert_eq!(err_code(deposit_shares(max_dust, p, s)), code(CustomErrorCode::DepositTooSmall));
            prop_assert_eq!(err_code(deposit_shares(0, p, s)), code(CustomErrorCode::DepositTooSmall));
        }

        #[test]
        fn dust_redeem_is_invalid_amount(p in price(), s in 2u64..=1_000_000_000_000_000_000) {
            // shares * price < scale ⇒ 0 assets.
            let max_dust = ((s - 1) as u128 / p as u128) as u64;
            prop_assert_eq!(err_code(redeem_assets(max_dust, p, s)), code(CustomErrorCode::InvalidAmount));
            prop_assert_eq!(err_code(redeem_assets(0, p, s)), code(CustomErrorCode::InvalidAmount));
        }

        #[test]
        fn staleness_boundary(ts in 1i64..=4_000_000_000, max in 0i64..=1_000_000_000, p in price()) {
            prop_assert!(require_fresh_price(p, ts, max, ts + max).is_ok());
            prop_assert_eq!(
                err_code(require_fresh_price(p, ts, max, ts + max + 1)),
                code(CustomErrorCode::PriceTooStale)
            );
        }

        #[test]
        fn price_check_never_panics(p: i128, ts: i64, max: i64, now: i64) {
            let _ = require_fresh_price(p, ts, max, now);
        }

        #[test]
        fn publication_id_window(last in 0u32..u32::MAX) {
            prop_assert_eq!(
                err_code(check_publication_id(last, last)),
                code(CustomErrorCode::RewardPublicationIdNotMonotonic)
            );
            prop_assert!(check_publication_id(last, last + 1).is_ok());
            if let Some(edge) = last.checked_add(LastRewardPublication::MAX_GAP) {
                prop_assert!(check_publication_id(last, edge).is_ok());
            }
            if let Some(beyond) = last.checked_add(LastRewardPublication::MAX_GAP + 1) {
                prop_assert_eq!(
                    err_code(check_publication_id(last, beyond)),
                    code(CustomErrorCode::RewardPublicationIdGapTooLarge)
                );
            }
        }

        #[test]
        fn reward_limits_never_panic(
            bps: u64, period_cap: u64, period: i64, last_at: i64, lifetime_cap: u64,
            distributed: u64, total_assets: u64, amount: u64, now: i64,
        ) {
            let config = reward_config(bps, period_cap, period, last_at, lifetime_cap, distributed);
            let _ = check_reward_limits(&config, total_assets, amount, now);
        }

        #[test]
        fn bps_cap_boundary(total_assets in 1u64.., bps in 1u64..=StakeRewardConfig::MAX_BPS) {
            let config = reward_config(bps, u64::MAX, 0, 0, u64::MAX, 0);
            let max_allowed =
                ((total_assets as u128 * bps as u128) / StakeRewardConfig::MAX_BPS as u128) as u64;
            prop_assert!(check_reward_limits(&config, total_assets, max_allowed, 0).is_ok());
            prop_assert_eq!(
                err_code(check_reward_limits(&config, total_assets, max_allowed + 1, 0)),
                code(CustomErrorCode::RewardExceedsMaxDelta)
            );
        }

        #[test]
        fn period_cap_boundary(cap in 0u64..u64::MAX) {
            let config = reward_config(StakeRewardConfig::MAX_BPS, cap, 0, 0, u64::MAX, 0);
            prop_assert!(check_reward_limits(&config, 0, cap, 0).is_ok());
            prop_assert_eq!(
                err_code(check_reward_limits(&config, 0, cap + 1, 0)),
                code(CustomErrorCode::ExceedsPeriodRewardCap)
            );
        }

        #[test]
        fn cooldown_boundary(last_at in 1i64..=4_000_000_000, period in 1i64..=1_000_000_000) {
            let config = reward_config(StakeRewardConfig::MAX_BPS, u64::MAX, period, last_at, u64::MAX, 0);
            prop_assert!(check_reward_limits(&config, 0, 1, last_at + period).is_ok());
            prop_assert_eq!(
                err_code(check_reward_limits(&config, 0, 1, last_at + period - 1)),
                code(CustomErrorCode::RewardCooldownNotElapsed)
            );
        }

        #[test]
        fn lifetime_cap_boundary(cap in 1u64..u64::MAX, distributed_fraction in 0u64..=100) {
            let distributed = ((cap as u128 * distributed_fraction as u128) / 100) as u64;
            let remaining = cap - distributed;
            let config = reward_config(StakeRewardConfig::MAX_BPS, u64::MAX, 0, 0, cap, distributed);
            prop_assert_eq!(check_reward_limits(&config, 0, remaining, 0).unwrap(), cap);
            prop_assert_eq!(
                err_code(check_reward_limits(&config, 0, remaining + 1, 0)),
                code(CustomErrorCode::ExceedsLifetimeRewardCap)
            );
        }
    }

    fn reward_config(
        max_reward_bps: u64,
        max_period_rewards: u64,
        reward_period_seconds: i64,
        last_reward_distributed_at: i64,
        max_total_rewards: u64,
        total_rewards_distributed: u64,
    ) -> StakeRewardConfig {
        StakeRewardConfig {
            max_reward_bps,
            max_period_rewards,
            reward_period_seconds,
            last_reward_distributed_at,
            max_total_rewards,
            total_rewards_distributed,
            bump: 0,
        }
    }

    #[test]
    fn first_publication_skips_cooldown() {
        let config = reward_config(StakeRewardConfig::MAX_BPS, u64::MAX, i64::MAX, 0, u64::MAX, 0);
        assert!(check_reward_limits(&config, 0, 1, 0).is_ok());
    }

    #[test]
    fn empty_vault_skips_bps_cap() {
        let config = reward_config(1, u64::MAX, 0, 0, u64::MAX, 0);
        assert!(check_reward_limits(&config, 0, u64::MAX, 0).is_ok());
    }

    #[test]
    fn cooldown_overflow_is_reported() {
        let config = reward_config(StakeRewardConfig::MAX_BPS, u64::MAX, i64::MAX, 1, u64::MAX, 0);
        assert_err(check_reward_limits(&config, 0, 1, i64::MAX), CustomErrorCode::Overflow);
    }

    #[test]
    fn lifetime_total_overflow_is_reported() {
        let config = reward_config(StakeRewardConfig::MAX_BPS, u64::MAX, 0, 0, u64::MAX, u64::MAX);
        assert_err(check_reward_limits(&config, 0, 1, 0), CustomErrorCode::Overflow);
    }

    #[test]
    fn max_reward_bps_bounds() {
        assert_err(validate_max_reward_bps(0), CustomErrorCode::InvalidMaxRewardBps);
        assert!(validate_max_reward_bps(1).is_ok());
        assert!(validate_max_reward_bps(StakeRewardConfig::MAX_BPS).is_ok());
        assert_err(
            validate_max_reward_bps(StakeRewardConfig::MAX_BPS + 1),
            CustomErrorCode::InvalidMaxRewardBps,
        );
    }

    #[test]
    fn price_errors_keep_their_codes() {
        assert_err(require_fresh_price(1, 0, 10, 5), CustomErrorCode::PriceNotInitialized);
        assert_err(require_fresh_price(0, 1, 10, 5), CustomErrorCode::PriceNotInitialized);
        assert_err(require_fresh_price(-1, 1, 10, 5), CustomErrorCode::PriceNotInitialized);
        assert_err(require_fresh_price(1, 1, 10, i64::MIN), CustomErrorCode::Overflow);
        assert_err(shares_to_assets(1, 1, 0), CustomErrorCode::DivisionByZero);
        assert_err(exchange_rate(1, 0), CustomErrorCode::DivisionByZero);
        assert_err(shares_to_assets(u64::MAX, i128::MAX, 1), CustomErrorCode::Overflow);
    }
}
