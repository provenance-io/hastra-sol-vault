use anchor_lang::prelude::*;

#[account]
pub struct Config {
    pub vault: Pubkey,
    pub mint: Pubkey,
    pub freeze_administrators: Vec<Pubkey>,
    pub rewards_administrators: Vec<Pubkey>,
    pub vault_authority: Pubkey,
    pub redeem_vault: Pubkey,
    pub bump: u8,
    pub paused: bool,
    pub allowed_external_mint_program: Pubkey
}

impl Config {
    // The vectors have a max length of 5 each and must include the Borsh overhead of 4 bytes for
    // the length prefix.
    pub const LEN: usize = 8 + 32 + 32 + (4 + (32 * 5)) + (4 + (32 * 5)) + 32 + 32 + 1 + 1 + 32;
}

#[account]
pub struct RewardsEpoch {
    pub index: u64,            // epoch id
    pub merkle_root: [u8; 32], // sha256 root (sortPairs)
    pub total: u64,            // optional: sum of all allocations
    pub created_ts: i64,
}
impl RewardsEpoch {
    pub const LEN: usize = 8 + 8 + 32 + 8 + 8;
}

#[account]
pub struct ClaimRecord {} // empty marker account, existence = already claimed
impl ClaimRecord {
    pub const LEN: usize = 8;
}

#[account]
pub struct RedemptionRequest {
    pub user: Pubkey,
    pub amount: u64,
    pub mint: Pubkey,
    pub bump: u8,
}

impl RedemptionRequest {
    pub const LEN: usize = 8 + 32 + 8 + 32 + 1;
}

/// One Merkle proof element.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct ProofNode {
    pub sibling: [u8; 32],
    pub is_left: bool,
}

// New vault token account config used to validate that the deposited token
// account is the correct one. This is used to prevent a user from depositing
// to the wrong token account even when it's owned by the vault authority.
// Adding a new vault token config eliminates the need for reallocating the
// program's config account size. The implication is, however, that this config
// must be set after the program has been deployed and initialized - which
// is a reasonable tradeoff to the complexity of updating the deployed
// config.
#[account]
pub struct VaultTokenAccountConfig {
    pub vault_token_account: Pubkey,
    pub bump: u8,
}

impl VaultTokenAccountConfig {
    pub const LEN: usize = 8 + 32 + 1; // discriminator + pubkey + bump
}

