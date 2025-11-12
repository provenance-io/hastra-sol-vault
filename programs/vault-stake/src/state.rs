use anchor_lang::prelude::*;

pub const MAX_UNBONDING_PERIOD: i64 = 31536000; // 365 days in seconds
pub const MIN_UNBONDING_PERIOD: i64 = 1; // 1 second
pub const MAX_ADMINISTRATORS: usize = 5; // max number of freeze/rewards administrators
pub const VIRTUAL_SHARES: u128 = 1_000_000; // multiplier to prevent inflation attacks
pub const VIRTUAL_ASSETS: u128 = 1_000_000; // multiplier to prevent inflation attacks

#[account]
pub struct StakeConfig {
    pub vault: Pubkey,
    pub mint: Pubkey,
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

// ========== HELPER FUNCTIONS for VIRTUAL SHARES CALCS  ==========
pub fn calculate_shares_to_assets(
    shares: u64,
    total_shares: u64,
    vault_balance: u64,
) -> Result<u64> {
    if total_shares == 0 {
        return Ok(0);
    }

    Ok((shares as u128)
        .checked_mul((vault_balance as u128).checked_add(VIRTUAL_ASSETS).unwrap())
        .unwrap()
        .checked_div((total_shares as u128).checked_add(VIRTUAL_SHARES).unwrap())
        .unwrap() as u64)
}

pub fn calculate_assets_to_shares(
    assets: u64,
    total_shares: u64,
    vault_balance: u64,
) -> Result<u64> {
    if total_shares == 0 {
        // First deposit calculation
        return Ok(((assets as u128)
            .checked_mul(VIRTUAL_SHARES)
            .unwrap()
            .checked_div(VIRTUAL_ASSETS)
            .unwrap()) as u64);
    }

    Ok((assets as u128)
        .checked_mul((total_shares as u128).checked_add(VIRTUAL_SHARES).unwrap())
        .unwrap()
        .checked_div((vault_balance as u128).checked_add(VIRTUAL_ASSETS).unwrap())
        .unwrap() as u64)
}

pub fn calculate_exchange_rate(
    total_shares: u64,
    vault_balance: u64,
) -> Result<u64> {
    // Returns assets per share, scaled by 1e9
    const SCALE: u128 = 1_000_000_000;

    if total_shares == 0 {
        return Ok(SCALE as u64); // 1:1 rate initially
    }

    Ok((vault_balance as u128).checked_add(VIRTUAL_ASSETS).unwrap()
        .checked_mul(SCALE)
        .unwrap()
        .checked_div((total_shares as u128).checked_add(VIRTUAL_SHARES).unwrap())
        .unwrap() as u64)
}
