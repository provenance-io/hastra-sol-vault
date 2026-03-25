use anchor_lang::prelude::*;

#[event]
pub struct DepositEvent {
    pub user: Pubkey,
    pub amount: u64,
    pub mint: Pubkey,
    pub vault: Pubkey,
}

#[event]
pub struct RewardsClaimed {
    pub user: Pubkey,
    pub epoch: u64,
    pub amount: u64,
    pub mint: Pubkey,
    pub vault: Pubkey,
}

#[event]
pub struct RedemptionRequested {
    pub user: Pubkey,
    pub amount: u64,
    pub vault_token_mint: Pubkey,
    pub mint: Pubkey,
}

#[event]
pub struct RedeemCompleted {
    pub user: Pubkey,
    pub admin: Pubkey,
    pub amount: u64,
    pub mint: Pubkey,
    pub vault: Pubkey,
}

#[event]
pub struct ExternalProgramMintEvent {
    pub admin: Pubkey,
    pub destination: Pubkey,
    pub amount: u64,
    pub mint: Pubkey,
    pub vault: Pubkey,
}

#[event]
pub struct SweepRedeemVaultEvent {
    pub admin: Pubkey,
    pub destination: Pubkey,
    pub amount: u64,
    pub vault: Pubkey,
}

#[event]
pub struct RewardsEpochCreated {
    pub admin: Pubkey,
    pub index: u64,
    pub merkle_root: [u8; 32],
    pub total: u64,
    pub created_ts: i64,
}