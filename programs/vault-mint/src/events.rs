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

/// Emitted when a user withdraws their own pending redemption request before it is completed.
#[event]
pub struct RedemptionCancelled {
    pub user: Pubkey,
    /// Amount the cancelled request had reserved for burning.
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

#[event]
pub struct MaxEpochCapUpdated {
    pub old_cap: u64,
    pub new_cap: u64,
}

#[event]
pub struct FirstCappedEpochSet {
    pub epoch_index: u64,
}

#[event]
pub struct LastRewardsEpochInitialized {
    pub start_index: u64,
}
