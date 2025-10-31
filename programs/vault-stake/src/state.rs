use anchor_lang::prelude::*;

pub const MAX_UNBONDING_PERIOD: i64 = 31536000; // 365 days in seconds
pub const MIN_UNBONDING_PERIOD: i64 = 1; // 1 second
pub const MAX_ADMINISTRATORS: usize = 5; // max number of freeze/rewards administrators

#[account]
pub struct StakeConfig {
    pub vault: Pubkey,
    pub mint: Pubkey,
    pub unbonding_period: i64,
    pub freeze_administrators: Vec<Pubkey>,
    pub rewards_administrators: Vec<Pubkey>,
    pub bump: u8,
    pub paused: bool,
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