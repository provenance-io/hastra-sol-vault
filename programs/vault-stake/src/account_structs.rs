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

    /// CHECK: This is the program data account that contains the update authority
    #[account(
        constraint = program_data.key() == get_program_data_address(&crate::id()) @ CustomErrorCode::InvalidProgramData
    )]
    pub program_data: UncheckedAccount<'info>,

    pub signer: Signer<'info>,
}

#[derive(Accounts)]
pub struct UpdateConfig<'info> {
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
    pub vault_token_account: Account<'info, TokenAccount>,

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
    pub user_vault_token_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        token::mint = stake_config.mint,
        constraint = user_mint_token_account.mint == stake_config.mint @ CustomErrorCode::InvalidMint,
        constraint = user_mint_token_account.owner == signer.key() @ CustomErrorCode::InvalidTokenOwner
    )]
    pub user_mint_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Unbond<'info> {
    #[account(
        seeds = [b"stake_config"], 
        bump = stake_config.bump
    )]
    pub stake_config: Account<'info, StakeConfig>,

    #[account(mut)]
    pub signer: Signer<'info>,

    #[account(
        constraint = mint.key() == stake_config.mint @ CustomErrorCode::InvalidMint
    )]
    pub mint: Account<'info, Mint>,

    #[account(
        token::mint = stake_config.mint,
        constraint = user_mint_token_account.mint == stake_config.mint @ CustomErrorCode::InvalidMint,
        constraint = user_mint_token_account.owner == signer.key() @ CustomErrorCode::InvalidMintAuthority

    )]
    pub user_mint_token_account: Account<'info, TokenAccount>,

    #[account(
        init,
        payer = signer,
        space = UnbondingTicket::LEN,
        seeds = [b"ticket", signer.key().as_ref()],
        bump
    )]
    pub ticket: Account<'info, UnbondingTicket>,

    pub system_program: Program<'info, System>,
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
    pub vault_token_account: Account<'info, TokenAccount>,

    /// CHECK: This is a PDA vault authority, validated by seeds and token account owner constraint
    #[account(
        seeds = [b"vault_authority"],
        bump,
        constraint = vault_authority.key() == stake_vault_token_account_config.vault_authority @ CustomErrorCode::InvalidVaultAuthority
    )]
    pub vault_authority: UncheckedAccount<'info>,

    #[account(mut)]
    pub signer: Signer<'info>,

    #[account(
        mut,
        close = signer, // return rent to user when done
        seeds = [b"ticket", signer.key().as_ref()],
        bump,
    )]
    pub ticket: Account<'info, UnbondingTicket>,

    #[account(
        mut,
        token::mint = stake_config.vault,
        constraint = user_vault_token_account.mint == stake_config.vault @ CustomErrorCode::InvalidVaultMint,
        constraint = user_vault_token_account.owner == signer.key() @ CustomErrorCode::InvalidTicketOwner
    )]
    pub user_vault_token_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        token::mint = stake_config.mint,
        constraint = user_mint_token_account.mint == stake_config.mint @ CustomErrorCode::InvalidMint,
        constraint = user_mint_token_account.owner == signer.key() @ CustomErrorCode::InvalidTicketOwner
    )]
    pub user_mint_token_account: Account<'info, TokenAccount>,

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
    pub stake_config: Account<'info, StakeConfig>,

    #[account(
        seeds = [b"config"], 
        bump = mint_config.bump,
        seeds::program = mint_program.key()
    )]
    pub mint_config: Account<'info, vault_mint::state::Config>,

    /// PDA that proves this call is from vault-stake
    /// This PDA is signed during the CPI call to vault-mint
    /// Only vault-stake can sign for this PDA
    /// CHECK: This is a PDA derived from vault-stake program, validated by seeds
    #[account(
        seeds = [b"external_mint_authority"],
        bump
    )]
    pub external_mint_authority: UncheckedAccount<'info>,
    
    /// CHECK: hastra vault-mint program's executable
    pub mint_program: AccountInfo<'info>,
    
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        mut,
        constraint = rewards_mint.key() == stake_config.vault @ CustomErrorCode::InvalidMint,
        constraint = rewards_mint.mint_authority.unwrap() == rewards_mint_authority.key() @ CustomErrorCode::InvalidMintAuthority
    )]
    pub rewards_mint: Account<'info, Mint>, // this seems odd, but the rewards are in the vault token mint
    
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
    pub stake_vault_token_account_config: Account<'info, StakeVaultTokenAccountConfig>,

    #[account(
        mut,
        token::mint = stake_config.vault,
        constraint = vault_token_account.mint == stake_config.vault @ CustomErrorCode::InvalidVaultMint,
        constraint = vault_token_account.key() == stake_vault_token_account_config.vault_token_account @ CustomErrorCode::InvalidVaultTokenAccount,
        constraint = vault_token_account.owner == stake_vault_token_account_config.vault_authority @ CustomErrorCode::InvalidVaultAuthority
    )]
    pub vault_token_account: Account<'info, TokenAccount>,

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
    pub reward_record: Account<'info, RewardPublicationRecord>,

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
}

#[derive(Accounts)]
pub struct SetStakeVaultTokenAccountConfig<'info> {
    #[account(
        seeds = [b"stake_config"],
        bump = stake_config.bump,
    )]
    pub stake_config: Account<'info, StakeConfig>,

    /// CHECK: This is a PDA that acts as vault authority, validated by seeds constraint
    #[account(
        seeds = [b"vault_authority"],
        bump
    )]
    pub vault_authority: UncheckedAccount<'info>,

    // Precise vault token account to verify in deposit
    #[account(
        constraint = vault_token_account.mint == stake_config.vault @ CustomErrorCode::InvalidVaultMint,
        constraint = vault_token_account.owner == vault_authority.key() @ CustomErrorCode::InvalidVaultAuthority,
    )]
    pub vault_token_account: Account<'info, TokenAccount>,

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

    #[account(mut)]
    pub signer: Signer<'info>, // Must be program update authority

    /// CHECK: This is the program data account that contains the update authority
    #[account(
        constraint = program_data.key() == get_program_data_address(&crate::id()) @ CustomErrorCode::InvalidProgramData
    )]
    pub program_data: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

