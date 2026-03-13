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

    #[msg("Invalid mint provided")]
    InvalidMint = 9,
    #[msg("Invalid vault mint provided")]
    InvalidVaultMint = 10,

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
    #[msg("Invalid token owner")]
    InvalidTokenOwner = 29,
    #[msg("Invalid mint program owner")]
    InvalidMintProgramOwner = 30,
    #[msg("Deposit amount is too small - would not receive any stake tokens")]
    DepositTooSmall = 31,
    #[msg("Division by zero error")]
    DivisionByZero = 32,
    #[msg("Arithmetic overflow error")]
    Overflow = 33,
    #[msg("Invalid vault token account")]
    InvalidVaultTokenAccount = 34,
    #[msg("Price has not been initialized; call verify_price first")]
    PriceNotInitialized = 35,
    #[msg("Stored price is too stale for deposit or redeem")]
    PriceTooStale = 36,
    #[msg("Chainlink report is outside its valid time window")]
    ReportStale = 37,
    #[msg("Report feed ID does not match configured feed ID")]
    InvalidFeedId = 38,
    #[msg("Chainlink verifier returned no report data")]
    ChainlinkVerifyFailed = 39,
    #[msg("Chainlink report valid_from_timestamp is ahead of current time - retry later")]
    FutureReportValidFromTimestamp = 40,

}
