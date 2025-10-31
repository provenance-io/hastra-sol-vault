use anchor_lang::prelude::*;

#[error_code]
pub enum CustomErrorCode {
    #[msg("Invalid amount")]
    InvalidAmount = 1,
    #[msg("Invalid authority")]
    InvalidAuthority = 2,
    #[msg("Insufficient balance")]
    InsufficientBalance = 3,
    #[msg("Invalid mint provided")]
    InvalidMint = 4,
    #[msg("Invalid vault mint provided")]
    InvalidVaultMint = 5,
    #[msg("Invalid mint authority")]
    InvalidMintAuthority = 6,
    #[msg("Insufficient vault balance")]
    InsufficientVaultBalance = 7,
    #[msg("Invalid vault authority")]
    InvalidVaultAuthority = 8,
    #[msg("Invalid freeze authority")]
    InvalidFreezeAuthority = 9,
    #[msg("ProgramData account did not match expected PDA.")]
    InvalidProgramData = 10,
    #[msg("Program has no upgrade authority (set to None).")]
    NoUpgradeAuthority = 11,
    #[msg("Signer is not the upgrade authority.")]
    InvalidUpgradeAuthority = 12,
    #[msg("Signer account missing.")]
    MissingSigner = 13,
    #[msg("Too many freeze administrators.")]
    TooManyAdministrators = 14,
    #[msg("Unauthorized freeze administrator")]
    UnauthorizedFreezeAdministrator = 15,
    #[msg("Invalid rewards epoch")]
    InvalidRewardsEpoch = 16,
    #[msg("Invalid merkle proof")]
    InvalidMerkleProof = 17,
    #[msg("Rewards already claimed for this epoch")]
    RewardsAlreadyClaimed = 18,
    #[msg("Invalid rewards administrator")]
    InvalidRewardsAdministrator = 19,
    #[msg("Invalid token owner")]
    InvalidTokenOwner = 20,
    #[msg("Redemption request already fulfilled")]
    AlreadyFulfilled = 21,
    #[msg("Redemption request not found")]
    RequestNotFound = 22,
    #[msg("Insufficient lamport funds in redeem vault authority")]
    InsufficientRedeemVaultFunds = 23,
    #[msg("Redeem request already exists")]
    RequestAlreadyExists = 24,
    #[msg("Vault and mint cannot be the same")]
    VaultAndMintCannotBeSame = 25,
    #[msg("Protocol is paused")]
    ProtocolPaused = 26,
    #[msg("Invalid program calling mint")]
    InvalidMintProgramCaller = 27,
}
