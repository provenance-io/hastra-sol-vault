use anchor_lang::prelude::*;

#[event]
pub struct DepositEvent {
    pub user: Pubkey,
    pub deposit_amount: u64,
    pub minted_amount: u64,
    pub mint: Pubkey,
    pub mint_supply: u64,
    pub vault: Pubkey,
    pub vault_balance: u64,
    pub total_assets: u64,
    pub total_shares: u64,
    pub totals_last_update_slot: u64,
}

#[event]
pub struct UnbondEvent {
    pub user: Pubkey,
    pub amount: u64,
    pub mint: Pubkey,
    pub vault: Pubkey,
}

#[event]
pub struct RedeemEvent {
    pub user: Pubkey,
    pub mint: Pubkey,
    pub requested_mint_amount: u64,
    pub mint_supply: u64,
    pub vault: Pubkey,
    pub redeemed_vault_amount: u64,
    pub vault_balance: u64,
    pub shares_burned: u64,
    pub total_assets: u64,
    pub total_shares: u64,
    pub totals_last_update_slot: u64,
}

#[event]
pub struct UnbondingPeriodUpdated {
    pub admin: Pubkey,
    pub old_period: i64,
    pub new_period: i64,
    pub mint: Pubkey,
    pub vault: Pubkey,
}

#[event]
pub struct RewardsPublished {
    pub admin: Pubkey,
    pub amount: u64,
    pub mint_program: Pubkey,
    pub vault_token_account: Pubkey,
    pub mint: Pubkey,
    pub vault: Pubkey,
    pub total_assets: u64,
    pub total_shares: u64,
    pub totals_last_update_slot: u64,
}
