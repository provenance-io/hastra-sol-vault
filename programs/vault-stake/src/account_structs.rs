use crate::error::*;
use crate::state::*;
use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

#[allow(deprecated)]
use anchor_lang::solana_program::bpf_loader_upgradeable::{self};

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = signer,
        space = StakeConfig::LEN,
        seeds = [b"stake_config"],
        bump
    )]
    pub stake_config: Account<'info, StakeConfig>,

    /// CHECK: This is a PDA that acts as vault authority, validated by seeds constraint
    /// This PDA will be set as the owner of the vault_token_account in the config
    /// The vault token account holds the deposited vault tokens (e.g., wYLDS)
    /// and is controlled by this program via the vault_authority PDA
    /// This ensures that only this program can move tokens out of the vault
    /// and prevents unauthorized access.
    #[account(
        seeds = [b"vault_authority"],
        bump
    )]
    pub vault_authority: UncheckedAccount<'info>,

    /// The vault token account that should be owned by vault_authority
    #[account(
        mut,
        constraint = vault_token_account.mint == vault_token_mint.key() @ CustomErrorCode::InvalidMint,
        constraint = (vault_token_account.owner == signer.key() || vault_token_account.owner == vault_authority.key()) @ CustomErrorCode::InvalidAuthority
    )]
    pub vault_token_account: Account<'info, TokenAccount>,

    // Captures the specific vault authority and vault token account for this stake config
    #[account(
        init,
        payer = signer,
        space = StakeVaultTokenAccountConfig::LEN,
        seeds = [
            b"stake_vault_token_account_config",
            stake_config.key().as_ref(),
        ],
        bump
    )]
    pub stake_vault_token_account_config: Account<'info, StakeVaultTokenAccountConfig>,

    pub vault_token_mint: Account<'info, Mint>,
    pub mint: Account<'info, Mint>,

    #[account(mut)]
    pub signer: Signer<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,

    /// CHECK: This is the program data account that contains the update authority
    #[account(
        constraint = program_data.key() == get_program_data_address(&crate::id()) @ CustomErrorCode::InvalidProgramData
    )]
    pub program_data: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct Pause<'info> {
    #[account(
        mut,
        seeds = [b"stake_config"],
        bump = stake_config.bump
    )]
    pub stake_config: Account<'info, StakeConfig>,

    pub signer: Signer<'info>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(
        seeds = [b"stake_config"], 
        bump = stake_config.bump
    )]
    pub stake_config: Account<'info, StakeConfig>,

    #[account(
        seeds = [
            b"stake_vault_token_account_config",
            stake_config.key().as_ref(),
        ],
        bump = stake_vault_token_account_config.bump,
    )]
    pub stake_vault_token_account_config: Account<'info, StakeVaultTokenAccountConfig>,

    #[account(
        mut,
        token::mint = stake_config.vault,
        constraint = vault_token_account.mint == stake_config.vault @ CustomErrorCode::InvalidVaultMint,
        constraint = vault_token_account.key() == stake_vault_token_account_config.vault_token_account @ CustomErrorCode::InvalidVaultTokenAccount,
        constraint = vault_token_account.owner == stake_vault_token_account_config.vault_authority @ CustomErrorCode::InvalidVaultAuthority
    )]
    pub vault_token_account: Box<Account<'info, TokenAccount>>,

    /// CHECK: This is a PDA that acts as vault authority, validated by seeds constraint
    #[account(
        seeds = [b"vault_authority"],
        bump,
        constraint = vault_authority.key() == stake_vault_token_account_config.vault_authority @ CustomErrorCode::InvalidVaultAuthority
    )]
    pub vault_authority: UncheckedAccount<'info>,

    #[account(
        mut,
        constraint = mint.key() == stake_config.mint @ CustomErrorCode::InvalidMint
    )]
    pub mint: Account<'info, Mint>,

    #[account(
        mut,
        constraint = vault_mint.key() == stake_config.vault @ CustomErrorCode::InvalidVaultMint
    )]
    pub vault_mint: Account<'info, Mint>,

    /// CHECK: This is a PDA that acts as mint authority, validated by seeds constraint
    #[account(
        seeds = [b"mint_authority"],
        bump,
        constraint = mint_authority.key() == mint.mint_authority.unwrap() @ CustomErrorCode::InvalidMintAuthority
    )]
    pub mint_authority: UncheckedAccount<'info>,

    #[account()]
    pub signer: Signer<'info>,

    #[account(
        mut,
        token::mint = stake_config.vault,
        constraint = user_vault_token_account.mint == stake_config.vault @ CustomErrorCode::InvalidVaultMint,
        constraint = user_vault_token_account.owner == signer.key() @ CustomErrorCode::InvalidTokenOwner
    )]
    pub user_vault_token_account: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        token::mint = stake_config.mint,
        constraint = user_mint_token_account.mint == stake_config.mint @ CustomErrorCode::InvalidMint,
        constraint = user_mint_token_account.owner == signer.key() @ CustomErrorCode::InvalidTokenOwner
    )]
    pub user_mint_token_account: Box<Account<'info, TokenAccount>>,

    #[account(
        seeds = [
            b"stake_price_config",
            stake_config.key().as_ref(),
        ],
        bump = stake_price_config.bump,
    )]
    pub stake_price_config: Box<Account<'info, StakePriceConfig>>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Redeem<'info> {
    #[account(
        seeds = [b"stake_config"],
        bump = stake_config.bump
    )]
    pub stake_config: Account<'info, StakeConfig>,

    #[account(
        seeds = [
            b"stake_vault_token_account_config",
            stake_config.key().as_ref(),
        ],
        bump = stake_vault_token_account_config.bump,
    )]
    pub stake_vault_token_account_config: Account<'info, StakeVaultTokenAccountConfig>,

    #[account(
        mut,
        token::mint = stake_config.vault,
        constraint = vault_token_account.mint == stake_config.vault @ CustomErrorCode::InvalidVaultMint,
        constraint = vault_token_account.key() == stake_vault_token_account_config.vault_token_account @ CustomErrorCode::InvalidVaultTokenAccount,
        constraint = vault_token_account.owner == stake_vault_token_account_config.vault_authority @ CustomErrorCode::InvalidVaultAuthority,
    )]
    pub vault_token_account: Box<Account<'info, TokenAccount>>,

    /// CHECK: This is a PDA vault authority, validated by seeds and token account owner constraint
    #[account(
        seeds = [b"vault_authority"],
        bump,
        constraint = vault_authority.key() == stake_vault_token_account_config.vault_authority @ CustomErrorCode::InvalidVaultAuthority
    )]
    pub vault_authority: UncheckedAccount<'info>,

    #[account(mut)]
    pub signer: Signer<'info>,

    /// Optional legacy unbonding ticket from the old two-step flow.
    /// If present (pass the ticket PDA address), it will be closed and rent returned to signer.
    /// If no ticket exists, pass the program's own ID — Anchor 0.31 treats it as None and skips all constraints.
    #[account(
        mut,
        close = signer,
        seeds = [b"ticket", signer.key().as_ref()],
        bump,
    )]
    pub ticket: Option<Account<'info, UnbondingTicket>>,

    #[account(
        mut,
        token::mint = stake_config.vault,
        constraint = user_vault_token_account.mint == stake_config.vault @ CustomErrorCode::InvalidVaultMint,
        constraint = user_vault_token_account.owner == signer.key() @ CustomErrorCode::InvalidTokenOwner
    )]
    pub user_vault_token_account: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        token::mint = stake_config.mint,
        constraint = user_mint_token_account.mint == stake_config.mint @ CustomErrorCode::InvalidMint,
        constraint = user_mint_token_account.owner == signer.key() @ CustomErrorCode::InvalidTokenOwner
    )]
    pub user_mint_token_account: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = mint.key() == stake_config.mint @ CustomErrorCode::InvalidMint
    )]
    pub mint: Account<'info, Mint>,

    #[account(
        mut,
        constraint = vault_mint.key() == stake_config.vault @ CustomErrorCode::InvalidVaultMint
    )]
    pub vault_mint: Account<'info, Mint>,

    #[account(
        seeds = [
            b"stake_price_config",
            stake_config.key().as_ref(),
        ],
        bump = stake_price_config.bump,
    )]
    pub stake_price_config: Box<Account<'info, StakePriceConfig>>,

    pub token_program: Program<'info, Token>,
}

// Helper function to derive the program data address
fn get_program_data_address(program_id: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[program_id.as_ref()], &bpf_loader_upgradeable::id()).0
}

#[derive(Accounts)]
pub struct UpdateFreezeAdministrators<'info> {
    #[account(
        mut,
        seeds = [b"stake_config"],
        bump = stake_config.bump
    )]
    pub stake_config: Account<'info, StakeConfig>,

    /// CHECK: This is the program data account that contains the update authority
    #[account(
        constraint = program_data.key() == get_program_data_address(&crate::id()) @ CustomErrorCode::InvalidProgramData
    )]
    pub program_data: UncheckedAccount<'info>,

    pub signer: Signer<'info>,
}

#[derive(Accounts)]
pub struct UpdateRewardsAdministrators<'info> {
    #[account(
        mut,
        seeds = [b"stake_config"],
        bump = stake_config.bump
    )]
    pub stake_config: Account<'info, StakeConfig>,

    /// CHECK: This is the program data account that contains the update authority
    #[account(
        constraint = program_data.key() == get_program_data_address(&crate::id()) @ CustomErrorCode::InvalidProgramData
    )]
    pub program_data: UncheckedAccount<'info>,

    pub signer: Signer<'info>,
}

#[derive(Accounts)]
pub struct FreezeTokenAccount<'info> {
    #[account(
        seeds = [b"stake_config"],
        bump = stake_config.bump
    )]
    pub stake_config: Account<'info, StakeConfig>,

    #[account(
        mut,
        constraint = token_account.mint == mint.key() @ CustomErrorCode::InvalidMint
    )]
    pub token_account: Account<'info, TokenAccount>,

    #[account(
        constraint = mint.freeze_authority == Some(freeze_authority_pda.key()).into() @ CustomErrorCode::InvalidFreezeAuthority,
        constraint = stake_config.mint == mint.key() @ CustomErrorCode::InvalidMint
    )]
    pub mint: Account<'info, Mint>,

    /// CHECK: This is the freeze authority PDA
    #[account(
        seeds = [b"freeze_authority"],
        bump
    )]
    pub freeze_authority_pda: UncheckedAccount<'info>,

    pub signer: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct ThawTokenAccount<'info> {
    #[account(
        seeds = [b"stake_config"],
        bump = stake_config.bump
    )]
    pub stake_config: Account<'info, StakeConfig>,

    #[account(
        mut,
        constraint = token_account.mint == mint.key() @ CustomErrorCode::InvalidMint
    )]
    pub token_account: Account<'info, TokenAccount>,

    #[account(
        constraint = mint.freeze_authority == Some(freeze_authority_pda.key()).into() @ CustomErrorCode::InvalidFreezeAuthority,
        constraint = stake_config.mint == mint.key() @ CustomErrorCode::InvalidMint
    )]
    pub mint: Account<'info, Mint>,

    /// CHECK: This is the freeze authority PDA
    #[account(
        seeds = [b"freeze_authority"],
        bump
    )]
    pub freeze_authority_pda: UncheckedAccount<'info>,

    pub signer: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

// admin publishes rewards
#[derive(Accounts)]
#[instruction(id: u32, amount: u64)]
pub struct PublishRewards<'info> {
    #[account(
        seeds = [b"stake_config"], 
        bump = stake_config.bump
    )]
    pub stake_config: Box<Account<'info, StakeConfig>>,

    #[account(
        seeds = [b"config"], 
        bump = mint_config.bump,
        seeds::program = mint_program.key()
    )]
    pub mint_config: Box<Account<'info, vault_mint::state::Config>>,

    /// PDA that proves this call is from this staking program.
    /// Signed during the CPI to vault-mint. Only this program can produce a valid
    /// signer for this address because it is derived from crate::id().
    /// CHECK: This is a PDA derived from this program's id, validated by seeds
    #[account(
        seeds = [b"external_mint_authority"],
        bump
    )]
    pub external_mint_authority: UncheckedAccount<'info>,

    /// CHECK: hastra vault-mint program's executable
    pub mint_program: AccountInfo<'info>,

    /// This program's own account, passed to vault-mint as the calling_program identifier
    /// so vault-mint can verify the caller against its allowed-program list.
    /// CHECK: Address is constrained to this program's deployed id
    #[account(constraint = this_program.key() == crate::id() @ CustomErrorCode::InvalidAuthority)]
    pub this_program: AccountInfo<'info>,

    /// The AllowedExternalMintPrograms PDA from vault-mint, passed through during the CPI to
    /// vault-mint::external_program_mint. vault-mint uses it to authorize callers beyond the
    /// legacy single-program field. This account is required here and in vault-mint, so it
    /// must already exist on-chain (typically created during vault-mint upgrade / migration
    /// via register_allowed_external_mint_program, which uses init_if_needed) before
    /// publish_rewards can succeed. Until any programs are registered, account data may be
    /// empty or too short to deserialize; vault-mint then treats the extended list as empty
    /// and only the legacy config field applies.
    /// CHECK: Derived from vault-mint's config; list membership is enforced in vault-mint
    #[account(
        seeds = [b"allowed_external_mint_programs", mint_config.key().as_ref()],
        seeds::program = mint_program.key(),
        bump,
    )]
    pub vault_mint_allowed_external_programs: UncheckedAccount<'info>,
    
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        mut,
        constraint = rewards_mint.key() == stake_config.vault @ CustomErrorCode::InvalidMint,
        constraint = rewards_mint.mint_authority.unwrap() == rewards_mint_authority.key() @ CustomErrorCode::InvalidMintAuthority
    )]
    pub rewards_mint: Box<Account<'info, Mint>>, // this seems odd, but the rewards are in the vault token mint
    
    /// CHECK: This is a PDA that acts as mint authority, validated by seeds constraint
    #[account(
        seeds = [b"mint_authority"],
        seeds::program = mint_program.key(),
        bump,
    )]
    pub rewards_mint_authority: UncheckedAccount<'info>,

    #[account(
        seeds = [
            b"stake_vault_token_account_config",
            stake_config.key().as_ref(),
        ],
        bump = stake_vault_token_account_config.bump,
    )]
    pub stake_vault_token_account_config: Box<Account<'info, StakeVaultTokenAccountConfig>>,

    #[account(
        mut,
        token::mint = stake_config.vault,
        constraint = vault_token_account.mint == stake_config.vault @ CustomErrorCode::InvalidVaultMint,
        constraint = vault_token_account.key() == stake_vault_token_account_config.vault_token_account @ CustomErrorCode::InvalidVaultTokenAccount,
        constraint = vault_token_account.owner == stake_vault_token_account_config.vault_authority @ CustomErrorCode::InvalidVaultAuthority
    )]
    pub vault_token_account: Box<Account<'info, TokenAccount>>,

    /// CHECK: This is a PDA that acts as vault authority, validated by seeds constraint
    #[account(
        seeds = [b"vault_authority"],
        bump,
        constraint = vault_authority.key() == stake_vault_token_account_config.vault_authority @ CustomErrorCode::InvalidVaultAuthority
    )]
    pub vault_authority: UncheckedAccount<'info>,

    #[account(
        mut,
        constraint = mint.key() == stake_config.mint @ CustomErrorCode::InvalidMint
    )]
    pub mint: Box<Account<'info, Mint>>,

    /// Reward record PDA to prevent duplicates
    #[account(
        init,
        payer = admin,
        space = RewardPublicationRecord::LEN,
        seeds = [
            b"reward_record",
            id.to_le_bytes().as_ref(),
            amount.to_le_bytes().as_ref(),
        ],
        bump
    )]
    pub reward_record: Box<Account<'info, RewardPublicationRecord>>,

    /// Reward cap config — enforces max_reward_bps limit on each publish.
    /// Created on first use with DEFAULT_BPS (75 BPS = 0.75%) if not yet initialized.
    /// This allows seamless upgrades without a separate initialization step.
    #[account(
        init_if_needed,
        payer = admin,
        space = StakeRewardConfig::LEN,
        seeds = [
            b"stake_reward_config",
            stake_config.key().as_ref(),
        ],
        bump
    )]
    pub stake_reward_config: Box<Account<'info, StakeRewardConfig>>,

    /// Extended reward guard config used by publish_rewards for absolute per-call cap,
    /// cooldown, and lifetime cap controls. Created lazily on first publish.
    #[account(
        init_if_needed,
        payer = admin,
        space = StakeRewardGuardConfig::LEN,
        seeds = [
            b"stake_reward_guard_config",
            stake_config.key().as_ref(),
        ],
        bump
    )]
    pub stake_reward_guard_config: Box<Account<'info, StakeRewardGuardConfig>>,

    pub system_program: Program<'info, System>,
    
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct ConversionView<'info> {
    #[account(
        seeds = [b"stake_config"],
        bump = stake_config.bump
    )]
    pub stake_config: Account<'info, StakeConfig>,

    #[account(
        constraint = mint.key() == stake_config.mint @ CustomErrorCode::InvalidMint
    )]
    pub mint: Account<'info, Mint>,

    #[account(
        constraint = vault_token_account.mint == stake_config.vault @ CustomErrorCode::InvalidVaultMint,
        constraint = vault_token_account.owner == vault_authority.key() @ CustomErrorCode::InvalidVaultAuthority
    )]
    pub vault_token_account: Account<'info, TokenAccount>,

    /// CHECK: This is a PDA that acts as vault authority, validated by seeds constraint
    #[account(
        seeds = [b"vault_authority"],
        bump
    )]
    pub vault_authority: UncheckedAccount<'info>,

    #[account(
        seeds = [b"stake_price_config", stake_config.key().as_ref()],
        bump = stake_price_config.bump,
    )]
    pub stake_price_config: Account<'info, StakePriceConfig>,
}

// ========== PRICE CONFIG ACCOUNT CONTEXTS ==========

/// Creates the StakePriceConfig PDA.
/// Only callable by the program upgrade authority.
/// Must be called once after deployment before any deposit/redeem can occur.
#[derive(Accounts)]
pub struct InitializePriceConfig<'info> {
    #[account(
        seeds = [b"stake_config"],
        bump = stake_config.bump
    )]
    pub stake_config: Account<'info, StakeConfig>,

    #[account(
        init,
        payer = signer,
        space = StakePriceConfig::LEN,
        seeds = [
            b"stake_price_config",
            stake_config.key().as_ref(),
        ],
        bump
    )]
    pub stake_price_config: Account<'info, StakePriceConfig>,

    #[account(mut)]
    pub signer: Signer<'info>,

    /// CHECK: This is the program data account that contains the update authority
    #[account(
        constraint = program_data.key() == get_program_data_address(&crate::id()) @ CustomErrorCode::InvalidProgramData
    )]
    pub program_data: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

/// Updates configuration parameters on an existing StakePriceConfig.
/// Only callable by the program upgrade authority.
/// Does NOT reset price or price_timestamp.
#[derive(Accounts)]
pub struct UpdatePriceConfig<'info> {
    #[account(
        seeds = [b"stake_config"],
        bump = stake_config.bump
    )]
    pub stake_config: Account<'info, StakeConfig>,

    #[account(
        mut,
        seeds = [
            b"stake_price_config",
            stake_config.key().as_ref(),
        ],
        bump = stake_price_config.bump,
    )]
    pub stake_price_config: Account<'info, StakePriceConfig>,

    pub signer: Signer<'info>,

    /// CHECK: This is the program data account that contains the update authority
    #[account(
        constraint = program_data.key() == get_program_data_address(&crate::id()) @ CustomErrorCode::InvalidProgramData
    )]
    pub program_data: UncheckedAccount<'info>,
}

/// Submits a signed Chainlink Data Streams report for on-chain verification.
/// On success, stores the benchmark_price and timestamp in StakePriceConfig.
/// Only callable by rewards administrators.
#[derive(Accounts)]
pub struct VerifyPrice<'info> {
    #[account(
        seeds = [b"stake_config"],
        bump = stake_config.bump
    )]
    pub stake_config: Account<'info, StakeConfig>,

    #[account(
        mut,
        seeds = [
            b"stake_price_config",
            stake_config.key().as_ref(),
        ],
        bump = stake_price_config.bump,
    )]
    pub stake_price_config: Account<'info, StakePriceConfig>,

    /// CHECK: Validated by the Chainlink verifier program during CPI
    pub chainlink_verifier_account: AccountInfo<'info>,

    /// CHECK: Validated by the Chainlink verifier program during CPI
    pub chainlink_access_controller: AccountInfo<'info>,

    /// CHECK: PDA derived from the report's feed ID; validated by the Chainlink verifier program
    pub chainlink_config_account: UncheckedAccount<'info>,

    /// CHECK: Must match stake_price_config.chainlink_program — enforced in processor
    pub chainlink_program: AccountInfo<'info>,

    pub signer: Signer<'info>,
}

/// FOR TESTING ONLY — directly sets the stored price and timestamp on StakePriceConfig.
/// This bypasses the Chainlink CPI and allows localnet tests to set an arbitrary price.
/// Access is restricted to the program upgrade authority (same as initialize).
/// DO NOT USE IN PRODUCTION — use verify_price with a real Chainlink report instead.
#[cfg(feature = "testing")]
#[derive(Accounts)]
pub struct SetPriceForTesting<'info> {
    #[account(
        seeds = [b"stake_config"],
        bump = stake_config.bump
    )]
    pub stake_config: Account<'info, StakeConfig>,

    #[account(
        mut,
        seeds = [
            b"stake_price_config",
            stake_config.key().as_ref(),
        ],
        bump = stake_price_config.bump,
    )]
    pub stake_price_config: Account<'info, StakePriceConfig>,

    pub signer: Signer<'info>,

    /// CHECK: This is the program data account that contains the update authority
    #[account(
        constraint = program_data.key() == get_program_data_address(&crate::id()) @ CustomErrorCode::InvalidProgramData
    )]
    pub program_data: UncheckedAccount<'info>,
}

/// Initializes the StakeRewardConfig PDA for a given StakeConfig.
/// Creates the account that enforces the maximum reward distribution cap (max_reward_bps).
/// Only callable by the program upgrade authority.
/// Must be called once after program deployment (or as part of the Squads upgrade proposal).
#[derive(Accounts)]
pub struct InitializeRewardConfig<'info> {
    #[account(
        seeds = [b"stake_config"],
        bump = stake_config.bump
    )]
    pub stake_config: Account<'info, StakeConfig>,

    #[account(
        init,
        payer = signer,
        space = StakeRewardConfig::LEN,
        seeds = [
            b"stake_reward_config",
            stake_config.key().as_ref(),
        ],
        bump
    )]
    pub stake_reward_config: Account<'info, StakeRewardConfig>,

    #[account(mut)]
    pub signer: Signer<'info>,

    /// CHECK: This is the program data account that contains the update authority
    #[account(
        constraint = program_data.key() == get_program_data_address(&crate::id()) @ CustomErrorCode::InvalidProgramData
    )]
    pub program_data: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

/// Updates max_reward_bps on an existing StakeRewardConfig.
/// Only callable by the program upgrade authority.
#[derive(Accounts)]
pub struct UpdateMaxRewardBps<'info> {
    #[account(
        seeds = [b"stake_config"],
        bump = stake_config.bump
    )]
    pub stake_config: Account<'info, StakeConfig>,

    #[account(
        mut,
        seeds = [
            b"stake_reward_config",
            stake_config.key().as_ref(),
        ],
        bump = stake_reward_config.bump,
    )]
    pub stake_reward_config: Account<'info, StakeRewardConfig>,

    pub signer: Signer<'info>,

    /// CHECK: This is the program data account that contains the update authority
    #[account(
        constraint = program_data.key() == get_program_data_address(&crate::id()) @ CustomErrorCode::InvalidProgramData
    )]
    pub program_data: UncheckedAccount<'info>,
}

/// Initializes the extended StakeRewardGuardConfig PDA for a given StakeConfig.
/// Only callable by the program upgrade authority.
#[derive(Accounts)]
pub struct InitializeRewardGuardConfig<'info> {
    #[account(
        seeds = [b"stake_config"],
        bump = stake_config.bump
    )]
    pub stake_config: Account<'info, StakeConfig>,

    #[account(
        init,
        payer = signer,
        space = StakeRewardGuardConfig::LEN,
        seeds = [
            b"stake_reward_guard_config",
            stake_config.key().as_ref(),
        ],
        bump
    )]
    pub stake_reward_guard_config: Account<'info, StakeRewardGuardConfig>,

    #[account(mut)]
    pub signer: Signer<'info>,

    /// CHECK: This is the program data account that contains the update authority
    #[account(
        constraint = program_data.key() == get_program_data_address(&crate::id()) @ CustomErrorCode::InvalidProgramData
    )]
    pub program_data: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

/// Updates max_period_rewards on an existing StakeRewardGuardConfig.
/// Only callable by the program upgrade authority.
#[derive(Accounts)]
pub struct UpdateMaxPeriodRewards<'info> {
    #[account(
        seeds = [b"stake_config"],
        bump = stake_config.bump
    )]
    pub stake_config: Account<'info, StakeConfig>,

    #[account(
        mut,
        seeds = [
            b"stake_reward_guard_config",
            stake_config.key().as_ref(),
        ],
        bump = stake_reward_guard_config.bump,
    )]
    pub stake_reward_guard_config: Account<'info, StakeRewardGuardConfig>,

    pub signer: Signer<'info>,

    /// CHECK: This is the program data account that contains the update authority
    #[account(
        constraint = program_data.key() == get_program_data_address(&crate::id()) @ CustomErrorCode::InvalidProgramData
    )]
    pub program_data: UncheckedAccount<'info>,
}

/// Updates reward_period_seconds on an existing StakeRewardGuardConfig.
/// Only callable by the program upgrade authority.
#[derive(Accounts)]
pub struct UpdateRewardPeriodSeconds<'info> {
    #[account(
        seeds = [b"stake_config"],
        bump = stake_config.bump
    )]
    pub stake_config: Account<'info, StakeConfig>,

    #[account(
        mut,
        seeds = [
            b"stake_reward_guard_config",
            stake_config.key().as_ref(),
        ],
        bump = stake_reward_guard_config.bump,
    )]
    pub stake_reward_guard_config: Account<'info, StakeRewardGuardConfig>,

    pub signer: Signer<'info>,

    /// CHECK: This is the program data account that contains the update authority
    #[account(
        constraint = program_data.key() == get_program_data_address(&crate::id()) @ CustomErrorCode::InvalidProgramData
    )]
    pub program_data: UncheckedAccount<'info>,
}

/// Updates max_total_rewards on an existing StakeRewardGuardConfig.
/// Only callable by the program upgrade authority.
#[derive(Accounts)]
pub struct UpdateMaxTotalRewards<'info> {
    #[account(
        seeds = [b"stake_config"],
        bump = stake_config.bump
    )]
    pub stake_config: Account<'info, StakeConfig>,

    #[account(
        mut,
        seeds = [
            b"stake_reward_guard_config",
            stake_config.key().as_ref(),
        ],
        bump = stake_reward_guard_config.bump,
    )]
    pub stake_reward_guard_config: Account<'info, StakeRewardGuardConfig>,

    pub signer: Signer<'info>,

    /// CHECK: This is the program data account that contains the update authority
    #[account(
        constraint = program_data.key() == get_program_data_address(&crate::id()) @ CustomErrorCode::InvalidProgramData
    )]
    pub program_data: UncheckedAccount<'info>,
}
