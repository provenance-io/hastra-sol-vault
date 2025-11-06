use anchor_lang::prelude::*;

#[error_code]
pub enum CustomErrorCode {
    #[msg("Invalid amount")]
    InvalidAmount = 1,
    #[msg("Invalid token received")]
    InvalidTokenReceived = 2,
    #[msg("Invalid vault")]
    InvalidVault = 3,
    #[msg("Invalid authority")]
    InvalidAuthority = 4,
    #[msg("Insufficient balance")]
    InsufficientBalance = 5,
    #[msg("Unbonding period not elapsed")]
    UnbondingPeriodNotElapsed = 6,
    #[msg("Insufficient unbonding balance")]
    InsufficientUnbondingBalance = 7,
    #[msg("Unbonding is currently in progress")]
    UnbondingInProgress = 8,

    #[msg("Invalid mint provided")]
    InvalidMint = 9,
    #[msg("Invalid vault mint provided")]
    InvalidVaultMint = 10,
    #[msg("Invalid ticket owner")]
    InvalidTicketOwner = 11,

    #[msg("Invalid mint authority")]
    InvalidMintAuthority = 12,
    #[msg("Insufficient vault balance")]
    InsufficientVaultBalance = 13,
    #[msg("Invalid vault authority")]
    InvalidVaultAuthority = 14,
    #[msg("Invalid freeze authority")]
    InvalidFreezeAuthority = 15,
    #[msg("ProgramData account did not match expected PDA.")]
    InvalidProgramData = 16,
    #[msg("Program has no upgrade authority (set to None).")]
    NoUpgradeAuthority = 17,
    #[msg("Signer is not the upgrade authority.")]
    InvalidUpgradeAuthority = 18,
    #[msg("Signer account missing.")]
    MissingSigner = 19,
    #[msg("Too many freeze administrators.")]
    TooManyAdministrators = 20,
    #[msg("Unauthorized freeze administrator")]
    UnauthorizedFreezeAdministrator = 21,
    #[msg("Invalid rewards administrator")]
    InvalidRewardsAdministrator = 25,
    #[msg("Vault and mint cannot be the same")]
    VaultAndMintCannotBeSame = 26,
    #[msg("Protocol is paused")]
    ProtocolPaused = 27,
    #[msg("Invalid bonding period")]
    InvalidBondingPeriod = 28,
    #[msg("Invalid token owner")]
    InvalidTokenOwner = 29,
    #[msg("Invalid mint program owner")]
    InvalidMintProgramOwner = 30,
    #[msg("Deposit amount is too small - would not receive any stake tokens")]
    DepositTooSmall = 31,
    #[msg("Division by zero error")]
    DivisionByZero = 32,
    
}
