use anchor_lang::prelude::*;

pub const MAX_ADMINISTRATORS: usize = 5; // max number of freeze/rewards administrators


#[account]
pub struct StakeConfig {
    pub vault: Pubkey,
    pub mint: Pubkey,
    // DEPRECATED: unbonding period removed. Kept for on-chain account layout compatibility.
    pub unbonding_period: i64,
    pub freeze_administrators: Vec<Pubkey>,
    pub rewards_administrators: Vec<Pubkey>,
    pub bump: u8,
    pub paused: bool
}

impl StakeConfig {
    // The vectors have a max length of 5 each and must include the Borsh overhead of 4 bytes for
    pub const LEN: usize = 8 + 32 + 32 + 8 + (4 + (32 * MAX_ADMINISTRATORS)) + (4 + (32 * MAX_ADMINISTRATORS)) + 1 + 1;
}

// DEPRECATED: No new tickets are created (unbond instruction removed).
// Kept so Anchor can deserialize existing on-chain tickets for closure during redeem.
#[account]
pub struct UnbondingTicket {
    pub owner: Pubkey,
    pub requested_amount: u64,
    pub start_balance: u64,
    pub start_ts: i64,
}

impl UnbondingTicket {
    pub const LEN: usize = 8 + 32 + 8 + 8 + 8;
}

#[account]
pub struct RewardPublicationRecord {
    pub id: u32,                 // Unique identifier
    pub amount: u64,               // Reward amount
    pub published_at: i64,         // Timestamp when published
    pub bump: u8,                  // PDA bump seed
}

impl RewardPublicationRecord {
    pub const LEN: usize = 8 +     // discriminator
        4 +    // id (u32)
        8 +     // amount
        8 +     // published_at
        1;      // bump
}

// New vault token account config used to validate that the deposited and redeemed token
// account is the correct one. This is used to prevent a user from depositing
// to the wrong token account even when it's owned by the vault authority.
// Adding a new vault token config eliminates the need for reallocating the
// program's config account size. The implication is, however, that this config
// must be set after the program has been deployed and initialized - which
// is a reasonable tradeoff to the complexity of updating the deployed
// config.
#[account]
pub struct StakeVaultTokenAccountConfig {
    pub vault_token_account: Pubkey,
    pub vault_authority: Pubkey,
    pub bump: u8,
}

impl StakeVaultTokenAccountConfig {
    pub const LEN: usize = 8 + 32 + 32 + 1; // discriminator + pubkey + pubkey + bump
}

// Reward cap config is a separate account (not part of StakeConfig) so that the deployed program's
// account layout remains unchanged. This follows the same pattern as StakeVaultTokenAccountConfig
// and StakePriceConfig.
// max_reward_bps is expressed in basis points (10_000 = 100%). Default at initialization: 75 (0.75%).
// Rationale: expected yield rate is ~0.28% of vault balance per distribution (vault_balance * 0.0028).
// The cap is set at 75 BPS (~2.7x the expected rate) to allow headroom while tightly limiting blast
// radius of a compromised rewards admin key.
// publish_rewards will reject any reward amount that exceeds total_assets * max_reward_bps / 10_000.
#[account]
pub struct StakeRewardConfig {
    pub max_reward_bps: u64,            // max reward per publish as % of total_assets, in BPS (75 = 0.75%)
    pub max_period_rewards: u64,        // absolute per-call cap (raw token units, e.g. 6 decimals)
    pub reward_period_seconds: i64,     // cooldown between successful publish_rewards calls
    pub last_reward_distributed_at: i64, // unix timestamp of the last successful publish
    pub max_total_rewards: u64,         // lifetime cumulative cap
    pub total_rewards_distributed: u64, // running lifetime total of successful publishes
    pub bump: u8,
}

impl StakeRewardConfig {
    // discriminator + max_reward_bps (u64) + max_period_rewards (u64) + reward_period_seconds (i64)
    // + last_reward_distributed_at (i64) + max_total_rewards (u64) + total_rewards_distributed (u64)
    // + bump (u8)
    pub const LEN: usize = 8 + 8 + 8 + 8 + 8 + 8 + 8 + 1;
    pub const MAX_BPS: u64 = 10_000;
    pub const DEFAULT_BPS: u64 = 75; // 0.75% — equivalent to 0.0075e18
    pub const DEFAULT_MAX_PERIOD_REWARDS: u64 = 1_000_000_000_000; // 1,000,000 wYLDS at 6 decimals
    pub const DEFAULT_REWARD_PERIOD_SECONDS: i64 = 3540; // 59 minutes
    pub const DEFAULT_MAX_TOTAL_REWARDS: u64 = 10_000_000_000_000; // 10,000,000 wYLDS at 6 decimals
}

// Price config is a separate account (not part of StakeConfig) so that the deployed program's
// account layout remains unchanged. This follows the same pattern as StakeVaultTokenAccountConfig.
#[account]
pub struct StakePriceConfig {
    pub chainlink_program: Pubkey,           // Chainlink verifier program ID
    pub chainlink_verifier_account: Pubkey,  // Verifier state account
    pub chainlink_access_controller: Pubkey, // Access controller account
    pub feed_id: [u8; 32],                   // Expected feed ID — validated on every verify_price call
    // price is the raw exchange_rate from the Chainlink V7 (Redemption Rates) report, cast to i128.
    // Convention: price = (wYLDS per 1 PRIME) * price_scale
    //   e.g. if 1 PRIME = 1.5 wYLDS and price_scale = 1_000_000_000, price = 1_500_000_000
    pub price: i128,
    pub price_scale: u64,        // Precision factor that matches the Chainlink feed (e.g. 1e9 or 1e18)
    pub price_timestamp: i64,    // Unix timestamp of last successful verify_price (0 = never set)
    pub price_max_staleness: i64, // Max seconds the stored price may be old before deposit/redeem reject it
    pub bump: u8,
}

impl StakePriceConfig {
    // 8 (discriminator) + 32 + 32 + 32 + 32 + 16 + 8 + 8 + 8 + 1 = 177
    pub const LEN: usize = 8 + 32 + 32 + 32 + 32 + 16 + 8 + 8 + 8 + 1;
}


