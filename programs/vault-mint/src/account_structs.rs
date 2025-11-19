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
        space = Config::LEN,
        seeds = [b"config"],
        bump
    )]
    pub config: Account<'info, Config>,

    #[account(
        constraint = vault_token_account.mint == vault_token_mint.key() @ CustomErrorCode::InvalidMint
    )]
    pub vault_token_account: Account<'info, TokenAccount>,

    /// CHECK: This is a PDA that acts as the redeem vault authority, validated by seeds constraint
    /// This PDA will be set as the owner of the redeem_vault_token_account in the config
    /// The redeem vault token account holds the deposited vault tokens (e.g., USDC)
    /// and is controlled by this program via the redeem_vault_authority PDA
    /// This ensures that only this program can move tokens out of the redeem vault
    /// and prevents unauthorized access.
    #[account(seeds =
        [b"redeem_vault_authority"],
        bump
    )]
    pub redeem_vault_authority: UncheckedAccount<'info>,

    #[account(
        mut,
        constraint = redeem_vault_token_account.mint == vault_token_mint.key() @ CustomErrorCode::InvalidMint,
        constraint = (redeem_vault_token_account.owner == signer.key() || redeem_vault_token_account.owner == redeem_vault_authority.key()) @ CustomErrorCode::InvalidAuthority
    )]
    pub redeem_vault_token_account: Account<'info, TokenAccount>,

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

    /// CHECK: The external program authorized to mint tokens via CPI
    #[account(executable)]
    pub allowed_external_mint_program: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct Pause<'info> {
    #[account(
        mut,
        seeds = [b"config"],
        bump = config.bump
    )]
    pub config: Account<'info, Config>,

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
        seeds = [b"config"], 
        bump = config.bump
    )]
    pub config: Account<'info, Config>,

    #[account(
        mut,
        token::mint = config.vault,
        constraint = vault_token_account.mint == config.vault @ CustomErrorCode::InvalidVaultMint,
        constraint = vault_token_account.owner == config.vault_authority @ CustomErrorCode::InvalidVaultAuthority
    )]
    pub vault_token_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = mint.key() == config.mint @ CustomErrorCode::InvalidMint
    )]
    pub mint: Account<'info, Mint>,

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
        token::mint = config.vault,
        constraint = user_vault_token_account.mint == config.vault @ CustomErrorCode::InvalidVaultMint,
        constraint = user_vault_token_account.owner == signer.key() @ CustomErrorCode::InvalidTokenOwner
    )]
    pub user_vault_token_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        token::mint = config.mint,
        constraint = user_mint_token_account.mint == config.mint @ CustomErrorCode::InvalidMint,
        constraint = user_mint_token_account.owner == signer.key() @ CustomErrorCode::InvalidTokenOwner
    )]
    pub user_mint_token_account: Account<'info, TokenAccount>,

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
        seeds = [b"config"],
        bump = config.bump
    )]
    pub config: Account<'info, Config>,

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
        seeds = [b"config"],
        bump = config.bump
    )]
    pub config: Account<'info, Config>,

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
        seeds = [b"config"],
        bump = config.bump
    )]
    pub config: Account<'info, Config>,

    #[account(
        mut,
        constraint = token_account.mint == mint.key() @ CustomErrorCode::InvalidMint
    )]
    pub token_account: Account<'info, TokenAccount>,

    #[account(
        constraint = mint.freeze_authority == Some(freeze_authority_pda.key()).into() @ CustomErrorCode::InvalidFreezeAuthority,
        constraint = config.mint == mint.key() @ CustomErrorCode::InvalidMint
    
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
        seeds = [b"config"],
        bump = config.bump
    )]
    pub config: Account<'info, Config>,

    #[account(
        mut,
        constraint = token_account.mint == mint.key() @ CustomErrorCode::InvalidMint
    )]
    pub token_account: Account<'info, TokenAccount>,

    #[account(
        constraint = mint.freeze_authority == Some(freeze_authority_pda.key()).into() @ CustomErrorCode::InvalidFreezeAuthority,
        constraint = config.mint == mint.key() @ CustomErrorCode::InvalidMint
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

// admin posts an epoch root
#[derive(Accounts)]
#[instruction(index: u64)]
pub struct CreateRewardsEpoch<'info> {
    #[account(
        seeds = [b"config"], 
        bump = config.bump
    )]
    pub config: Account<'info, Config>,

    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        init,
        payer=admin,
        space=RewardsEpoch::LEN,
        seeds=[b"epoch", index.to_le_bytes().as_ref()],
        bump
    )]
    pub epoch: Account<'info, RewardsEpoch>,
    pub system_program: Program<'info, System>,
}

// user claims this epoch’s amount
#[derive(Accounts)]
pub struct ClaimRewards<'info> {
    #[account(
        seeds = [b"config"], 
        bump = config.bump
    )]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub user: Signer<'info>,
    pub epoch: Account<'info, RewardsEpoch>,
    #[account(
        init,
        payer = user,
        space = ClaimRecord::LEN,
        seeds = [b"claim", epoch.key().as_ref(), user.key().as_ref()],
        bump
    )]
    pub claim_record: Account<'info, ClaimRecord>,

    #[account(
        mut,
        constraint = mint.key() == config.mint @ CustomErrorCode::InvalidMint
    )]
    pub mint: Account<'info, Mint>,

    /// CHECK: This is a PDA that acts as mint authority, validated by seeds constraint
    #[account(
        seeds = [b"mint_authority"],
        bump,
        constraint = mint_authority.key() == mint.mint_authority.unwrap() @ CustomErrorCode::InvalidMintAuthority
    )]
    pub mint_authority: UncheckedAccount<'info>,

    #[account(
        mut,
        constraint = user_mint_token_account.mint == mint.key() @ CustomErrorCode::InvalidMint,
        constraint = user_mint_token_account.owner == user.key() @ CustomErrorCode::InvalidTokenOwner
    )]
    pub user_mint_token_account: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RequestRedeem<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,

    #[account(
        mut,
        constraint = user_mint_token_account.mint == mint.key() @ CustomErrorCode::InvalidMint,
        constraint = user_mint_token_account.owner == signer.key() @ CustomErrorCode::InvalidTokenOwner
    )]
    pub user_mint_token_account: Account<'info, TokenAccount>,

    // NOTE: payer is the user (signer), NOT the PDA
    #[account(
        init,
        payer = signer,
        space = RedemptionRequest::LEN,
        seeds = [b"redemption_request", signer.key().as_ref()],
        bump
    )]
    pub redemption_request: Account<'info, RedemptionRequest>,

    /// CHECK: PDA delegate/authority; NOT a signer, NOT a payer
    #[account(
        seeds = [b"redeem_vault_authority"],
        bump
    )]
    pub redeem_vault_authority: AccountInfo<'info>,

    #[account(
        constraint = mint.key() == config.mint @ CustomErrorCode::InvalidMint
    )]
    pub mint: Account<'info, Mint>,

    #[account(
        seeds = [b"config"], 
        bump = config.bump
    )]
    pub config: Account<'info, Config>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct CompleteRedeem<'info> {
    #[account()]
    pub admin: Signer<'info>,

    /// The original user (to validate and to receive close rent)
    /// (Not required to be a signer here.)
    /// must be writeable to close the account = user will transfer rent to user
    #[account(mut)]
    pub user: SystemAccount<'info>,

    #[account(
        mut,
        close = user,   // refund rent to the original user
        seeds = [b"redemption_request", user.key().as_ref()],
        bump = redemption_request.bump
        // optionally: has_one = user,
    )]
    pub redemption_request: Account<'info, RedemptionRequest>,

    #[account(
        mut,
        constraint = user_mint_token_account.mint == config.mint @ CustomErrorCode::InvalidMint,
        constraint = user_mint_token_account.owner == user.key() @ CustomErrorCode::InvalidTokenOwner
    )]
    pub user_mint_token_account: Account<'info, TokenAccount>, // wYLDS

    #[account(
        mut,
        constraint = user_vault_token_account.mint == config.vault @ CustomErrorCode::InvalidVaultMint,
    )]
    pub user_vault_token_account: Account<'info, TokenAccount>, // USDC dest

    #[account(
        mut,
        constraint = redeem_vault_token_account.mint == config.vault @ CustomErrorCode::InvalidVaultMint,
        constraint = redeem_vault_token_account.owner == redeem_vault_authority.key() @ CustomErrorCode::InvalidVaultAuthority
    )]
    pub redeem_vault_token_account: Account<'info, TokenAccount>, // USDC source

    #[account(
        mut,
        constraint = mint.key() == redemption_request.mint,
        constraint = mint.key() == config.mint @ CustomErrorCode::InvalidMint
    )]
    pub mint: Account<'info, Mint>, // wYLDS mint

    /// CHECK: PDA authority (delegate & vault authority)
    #[account(
        seeds = [b"redeem_vault_authority"],
        bump
    )]
    pub redeem_vault_authority: AccountInfo<'info>,

    #[account(
        seeds = [b"config"],
        bump = config.bump
    )]
    pub config: Account<'info, Config>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct ExternalProgramMint<'info> {
    #[account(
        seeds = [b"config"],
        bump = config.bump,
    )]
    pub config: Account<'info, Config>,

    /// PDA from the calling program that proves CPI origin
    /// This PDA is derived using the allowed_external_mint_program's ID
    /// Only that program can sign for this PDA, proving the call is from CPI
    /// CHECK: Verified by seeds constraint against allowed_external_mint_program
    #[account(
    seeds = [b"external_mint_authority"],
    seeds::program = config.allowed_external_mint_program,
    bump,
    )]
    pub external_mint_authority: UncheckedAccount<'info>,

    #[account(
        mut,
        constraint = mint.key() == config.mint @ CustomErrorCode::InvalidMint
    )]
    pub mint: Account<'info, Mint>,

    /// CHECK: This is a PDA that acts as mint authority, validated by seeds constraint
    #[account(
        seeds = [b"mint_authority"],
        bump,
        constraint = mint_authority.key() == mint.mint_authority.unwrap() @ CustomErrorCode::InvalidMintAuthority
    )]
    pub mint_authority: UncheckedAccount<'info>,

    /// The rewards administrator who authorized this mint operation
    /// This is NOT a Signer in the CPI context - the PDA signs the CPI, not the admin
    /// The admin's pubkey is just passed through for authorization checking
    /// CHECK: Verified against config.rewards_administrators list in processor
    pub admin: AccountInfo<'info>,
    
    #[account(
        mut,
        constraint = destination.mint == mint.key() @ CustomErrorCode::InvalidMint
    )]
    pub destination: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct UpdateVaultTokenAccount<'info> {
    #[account(
        mut,
        seeds = [b"config"],
        bump = config.bump
    )]
    pub config: Account<'info, Config>,

    #[account(
        mut,
        token::mint = config.vault,
        constraint = vault_token_account.mint == config.vault @ CustomErrorCode::InvalidVaultMint,
    )]
    pub vault_token_account: Account<'info, TokenAccount>,
    
    /// CHECK: This is the program data account that contains the update authority
    #[account(
        constraint = program_data.key() == get_program_data_address(&crate::id()) @ CustomErrorCode::InvalidProgramData
    )]
    pub program_data: UncheckedAccount<'info>,

    pub signer: Signer<'info>,
}

#[derive(Accounts)]
pub struct SweepRedeemVaultFunds<'info> {
    #[account(
        seeds = [b"config"],
        bump = config.bump
    )]
    pub config: Account<'info, Config>,

    /// CHECK: This is a PDA that acts as the redeem vault authority, validated by seeds constraint
    #[account(
        seeds =
        [b"redeem_vault_authority"],
        bump
    )]
    pub redeem_vault_authority: UncheckedAccount<'info>,

    #[account(
        mut,
        constraint = redeem_vault_token_account.mint == config.vault @ CustomErrorCode::InvalidVaultMint,
        constraint = redeem_vault_token_account.owner == redeem_vault_authority.key() @ CustomErrorCode::InvalidVaultAuthority
    )]
    pub redeem_vault_token_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = destination_token_account.mint == config.vault @ CustomErrorCode::InvalidVaultMint,
    )]
    pub destination_token_account: Account<'info, TokenAccount>,

    /// CHECK: This is the program data account that contains the update authority
    #[account(
        constraint = program_data.key() == get_program_data_address(&crate::id()) @ CustomErrorCode::InvalidProgramData
    )]
    pub program_data: UncheckedAccount<'info>,

    pub signer: Signer<'info>,
    
    pub token_program: Program<'info, Token>,
}