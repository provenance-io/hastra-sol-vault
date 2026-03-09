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

// Price config is a separate account (not part of StakeConfig) so that the deployed program's
// account layout remains unchanged. This follows the same pattern as StakeVaultTokenAccountConfig.
#[account]
pub struct StakePriceConfig {
    pub chainlink_program: Pubkey,           // Chainlink verifier program ID
    pub chainlink_verifier_account: Pubkey,  // Verifier state account
    pub chainlink_access_controller: Pubkey, // Access controller account
    pub feed_id: [u8; 32],                   // Expected feed ID — validated on every verify_price call
    // price is the raw benchmark_price from the Chainlink V3 report, cast to i128.
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


