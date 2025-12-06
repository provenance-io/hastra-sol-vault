use crate::account_structs::*;
use crate::error::*;
use crate::events::*;
use crate::guard::validate_program_update_authority;
use crate::state::ProofNode;
use anchor_lang::prelude::*;
use anchor_lang::solana_program::hash::hashv;
use anchor_spl::token::spl_token::instruction::AuthorityType;
use anchor_spl::token::{self, MintTo, Transfer};

pub fn initialize(
    ctx: Context<Initialize>,
    freeze_administrators: Vec<Pubkey>,
    rewards_administrators: Vec<Pubkey>
) -> Result<()> {
    msg!("Initializing with vault_token_mint: {}", ctx.accounts.vault_token_mint.key());
    msg!("Vault mint account: {}", ctx.accounts.vault_token_mint.key());

    validate_program_update_authority(&ctx.accounts.program_data, &ctx.accounts.signer)?;

    require!(
        freeze_administrators.len() <= 5,
        CustomErrorCode::TooManyAdministrators
    );

    require!(
        rewards_administrators.len() <= 5,
        CustomErrorCode::TooManyAdministrators
    );

    require!(
        ctx.accounts.vault_token_mint.key() != ctx.accounts.mint.key(),
        CustomErrorCode::VaultAndMintCannotBeSame
    );

    let config = &mut ctx.accounts.config;
    config.vault = ctx.accounts.vault_token_mint.key();
    config.mint = ctx.accounts.mint.key();
    config.freeze_administrators = freeze_administrators;
    config.rewards_administrators = rewards_administrators;
    config.vault_authority = ctx.accounts.vault_token_account.owner;
    config.allowed_external_mint_program = ctx.accounts.allowed_external_mint_program.key();
    config.bump = ctx.bumps.config;

    // The redeem vault token account must be owned by the program-derived address (PDA)
    // and is a token account that holds the deposited vault tokens (e.g., USDC).
    // This ensures that only the program can move tokens out of this account.
    // Only set vault token account to PDA authority if it's not already set to vault_authority

    if ctx.accounts.redeem_vault_token_account.owner == ctx.accounts.signer.key() {
        let seeds: &[&[u8]] = &[
            b"redeem_vault_authority",
            &[ctx.bumps.redeem_vault_authority],
        ];
        let signer = &[&seeds[..]];
        token::set_authority(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                token::SetAuthority {
                    account_or_mint: ctx.accounts.redeem_vault_token_account.to_account_info(),
                    current_authority: ctx.accounts.signer.to_account_info(),
                },
                signer,
            ),
            AuthorityType::AccountOwner,
            Some(ctx.accounts.redeem_vault_authority.key()),
        )?;
    }

    Ok(())
}

pub fn pause(ctx: Context<Pause>, pause: bool) -> Result<()> {
    // Validate that the signer is the program's update authority
    validate_program_update_authority(&ctx.accounts.program_data, &ctx.accounts.signer)?;

    let config = &mut ctx.accounts.config;
    config.paused = pause;

    msg!("Program paused state set to: {}", pause);
    Ok(())
}

pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
    require!(!ctx.accounts.config.paused, CustomErrorCode::ProtocolPaused);
    require!(amount > 0, CustomErrorCode::InvalidAmount);

    // Validate that vault_token_account is owned by the configured vault authority
    require!(
        ctx.accounts.vault_token_account.owner == ctx.accounts.config.vault_authority,
        CustomErrorCode::InvalidVaultAuthority
    );

    let cpi_accounts = Transfer {
        from: ctx.accounts.user_vault_token_account.to_account_info(),
        to: ctx.accounts.vault_token_account.to_account_info(),
        authority: ctx.accounts.signer.to_account_info(),
    };
    token::transfer(
        CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi_accounts),
        amount,
    )?;

    let seeds: &[&[u8]] = &[b"mint_authority", &[ctx.bumps.mint_authority]];
    let signer = &[&seeds[..]];
    let cpi_accounts = MintTo {
        mint: ctx.accounts.mint.to_account_info(),
        to: ctx.accounts.user_mint_token_account.to_account_info(),
        authority: ctx.accounts.mint_authority.to_account_info(),
    };
    token::mint_to(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            cpi_accounts,
            signer,
        ),
        amount,
    )?;

    msg!("Emitting DepositEvent");
    emit!(DepositEvent {
        user: ctx.accounts.signer.key(),
        amount,
        mint: ctx.accounts.mint.key(),
        vault: ctx.accounts.vault_token_account.mint,
    });
    msg!("Emitted DepositEvent");

    Ok(())
}

pub fn request_redeem(ctx: Context<RequestRedeem>, amount: u64) -> Result<()> {
    require!(!ctx.accounts.config.paused, CustomErrorCode::ProtocolPaused);
    require!(amount > 0, CustomErrorCode::InvalidAmount);

    // Check user's mint token balance
    let user_balance = ctx.accounts.user_mint_token_account.amount;
    require!(user_balance >= amount, CustomErrorCode::InsufficientBalance);

    let vault_balance = ctx.accounts.redeem_vault_authority.lamports();
    require!(
        vault_balance > 100_000, // ~0.0001 SOL buffer
        CustomErrorCode::InsufficientRedeemVaultFunds
    );

    // amount_to_redeem = min(user wYLDS balance, requested)
    // We do this to prevent the program from over-burning when the
    // redeem is completed. The complete redeem will also check the
    // redeem amount against the user balance at the time of completion to
    // prevent burn error.
    let amount_to_redeem = std::cmp::min(user_balance, amount);
    require!(amount_to_redeem > 0, CustomErrorCode::InsufficientRedemptionBalance);

    msg!("RequestRedeem user account balance: {}", user_balance);
    msg!("Requested amount to redeem: {}", amount);
    msg!("Actual amount to redeem: {}", amount_to_redeem);

    // Set burn authority to the redeem vault authority PDA so it can burn tokens later
    token::approve(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            token::Approve {
                to: ctx.accounts.user_mint_token_account.to_account_info(),
                delegate: ctx.accounts.redeem_vault_authority.to_account_info(),
                authority: ctx.accounts.signer.to_account_info(),
            },
        ),
        amount_to_redeem,
    )?;

    msg!("Emitting RedemptionRequested");
    emit!(RedemptionRequested {
        user: ctx.accounts.signer.key(),
        amount: amount_to_redeem,
        vault_token_mint: ctx.accounts.config.vault,
        mint: ctx.accounts.config.mint,
    });
    msg!("Emitted RedemptionRequested");

    msg!("recording redemption request");
    // Record the request (creates a lock on the user)
    let request = &mut ctx.accounts.redemption_request;
    request.user = ctx.accounts.signer.key();
    request.amount = amount_to_redeem;
    request.mint = ctx.accounts.config.mint;
    request.bump = ctx.bumps.redemption_request;

    msg!("done with request redeem");
    Ok(())
}

pub fn complete_redeem(ctx: Context<CompleteRedeem>) -> Result<()> {
    // Admin gate
    require!(
        ctx.accounts
            .config
            .rewards_administrators
            .contains(&ctx.accounts.admin.key()),
        CustomErrorCode::InvalidRewardsAdministrator
    );

    let req = &ctx.accounts.redemption_request;

    // The request redeem function will set the redeem amount to the min
    // of the requested amount and the user's mint balance at the request.
    // This prevents program from burning more than their balance at the time.
    // However, we also do the same here to prevent error in the situation where
    // the user transfers mint out of their account before this complete request
    // executes.
    let user_mint_balance = ctx.accounts.user_mint_token_account.amount;
    let amount_to_redeem = std::cmp::min(user_mint_balance, req.amount);
    require!(amount_to_redeem > 0, CustomErrorCode::InvalidAmount);

    // check vault has enough USDC
    require!(
        ctx.accounts.redeem_vault_token_account.amount >= amount_to_redeem,
        CustomErrorCode::InsufficientVaultBalance
    );

    // signer seeds for the PDA
    let seeds: &[&[u8]] = &[
        b"redeem_vault_authority",
        &[ctx.bumps.redeem_vault_authority],
    ];
    let signer = &[&seeds[..]];

    // Burn user's wYLDS using PDA as delegate
    token::burn(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            token::Burn {
                mint: ctx.accounts.mint.to_account_info(),
                from: ctx.accounts.user_mint_token_account.to_account_info(),
                authority: ctx.accounts.redeem_vault_authority.to_account_info(),
            },
            signer,
        ),
        amount_to_redeem,
    )?;

    // Transfer USDC from redeem vault to user (PDA is authority)
    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.redeem_vault_token_account.to_account_info(),
                to: ctx.accounts.user_vault_token_account.to_account_info(),
                authority: ctx.accounts.redeem_vault_authority.to_account_info(),
            },
            signer,
        ),
        amount_to_redeem,
    )?;

    msg!("Emitting RedeemCompleted");
    emit!(RedeemCompleted {
        user: ctx.accounts.user.key(),
        admin: ctx.accounts.admin.key(),
        amount: amount_to_redeem,
        mint: ctx.accounts.mint.key(),
        vault: ctx.accounts.redeem_vault_token_account.mint,
    });
    msg!("Emitted RedeemCompleted");

    // Anchor will auto-close redemption_request to `user` per the accounts attr
    Ok(())
}

// Set the mint token's freeze authority to the program PDA
// Update the list of freeze administrators (only program update authority can do this)
pub fn update_freeze_administrators(
    ctx: Context<UpdateFreezeAdministrators>,
    new_administrators: Vec<Pubkey>,
) -> Result<()> {
    // Validate that the signer is the program's update authority
    validate_program_update_authority(&ctx.accounts.program_data, &ctx.accounts.signer)?;

    let config = &mut ctx.accounts.config;

    require!(
        new_administrators.len() <= 5,
        CustomErrorCode::TooManyAdministrators
    );

    config.freeze_administrators = new_administrators;

    msg!(
        "Freeze administrators updated. New count: {}",
        config.freeze_administrators.len()
    );
    Ok(())
}

// Set the mint token's rewards authority to the program PDA
// Update the list of rewards administrators (only program update authority can do this)
pub fn update_rewards_administrators(
    ctx: Context<UpdateRewardsAdministrators>,
    new_administrators: Vec<Pubkey>,
) -> Result<()> {
    // Validate that the signer is the program's update authority
    validate_program_update_authority(&ctx.accounts.program_data, &ctx.accounts.signer)?;

    let config = &mut ctx.accounts.config;

    require!(
        new_administrators.len() <= 5,
        CustomErrorCode::TooManyAdministrators
    );

    config.rewards_administrators = new_administrators;

    msg!(
        "Rewards administrators updated. New count: {}",
        config.rewards_administrators.len()
    );
    Ok(())
}

// Freeze a specific token account (only freeze administrators can do this)
pub fn freeze_token_account(ctx: Context<FreezeTokenAccount>) -> Result<()> {
    let config = &ctx.accounts.config;
    let signer = ctx.accounts.signer.key();

    // Verify signer is a freeze administrator
    require!(
        config.freeze_administrators.contains(&signer),
        CustomErrorCode::UnauthorizedFreezeAdministrator
    );

    let freeze_authority_seeds: &[&[&[u8]]] =
        &[&[b"freeze_authority", &[ctx.bumps.freeze_authority_pda]]];

    let cpi_accounts = token::FreezeAccount {
        account: ctx.accounts.token_account.to_account_info(),
        mint: ctx.accounts.mint.to_account_info(),
        authority: ctx.accounts.freeze_authority_pda.to_account_info(),
    };

    let cpi_ctx = CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        cpi_accounts,
        freeze_authority_seeds,
    );

    token::freeze_account(cpi_ctx)?;

    msg!(
        "Token account {} frozen by administrator {}",
        ctx.accounts.token_account.key(),
        signer
    );
    Ok(())
}

// Thaw a specific token account (only freeze administrators can do this)
pub fn thaw_token_account(ctx: Context<ThawTokenAccount>) -> Result<()> {
    let config = &ctx.accounts.config;
    let signer = ctx.accounts.signer.key();

    // Verify signer is a freeze administrator
    require!(
        config.freeze_administrators.contains(&signer),
        CustomErrorCode::UnauthorizedFreezeAdministrator
    );

    let freeze_authority_seeds: &[&[&[u8]]] =
        &[&[b"freeze_authority", &[ctx.bumps.freeze_authority_pda]]];

    let cpi_accounts = token::ThawAccount {
        account: ctx.accounts.token_account.to_account_info(),
        mint: ctx.accounts.mint.to_account_info(),
        authority: ctx.accounts.freeze_authority_pda.to_account_info(),
    };

    let cpi_ctx = CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        cpi_accounts,
        freeze_authority_seeds,
    );

    token::thaw_account(cpi_ctx)?;

    msg!(
        "Token account {} thawed by administrator {}",
        ctx.accounts.token_account.key(),
        signer
    );
    Ok(())
}

pub fn create_rewards_epoch(
    ctx: Context<CreateRewardsEpoch>,
    index: u64,
    merkle_root: [u8; 32],
    total: u64,
) -> Result<()> {
    require!(
        ctx.accounts
            .config
            .rewards_administrators
            .contains(&ctx.accounts.admin.key()),
        CustomErrorCode::InvalidRewardsAdministrator
    );
    let e = &mut ctx.accounts.epoch;
    e.index = index;
    e.merkle_root = merkle_root;
    e.total = total;
    e.created_ts = Clock::get()?.unix_timestamp;
    Ok(())
}

pub fn claim_rewards(ctx: Context<ClaimRewards>, amount: u64, proof: Vec<ProofNode>) -> Result<()> {
    require!(!ctx.accounts.config.paused, CustomErrorCode::ProtocolPaused);
    require!(amount > 0, CustomErrorCode::InvalidAmount);
    // leaf = sha256(user || amount_le || epoch_index_le)
    let mut data = Vec::with_capacity(32 + 8 + 8);
    data.extend_from_slice(ctx.accounts.user.key.as_ref());
    data.extend_from_slice(&amount.to_le_bytes());
    data.extend_from_slice(&ctx.accounts.epoch.index.to_le_bytes());
    let mut node = hashv(&[&data]).to_bytes();

    msg!("User Leaf node: {}", hex::encode(node));

    // iterate through proof
    for (i, step) in proof.iter().enumerate() {
        let sib = &step.sibling;

        if sib.iter().all(|&b| b == 0) {
            msg!("[{}] right: sibling is zero - hashing just the node", i);
            node = hashv(&[&node]).to_bytes();
            continue;
        }

        if step.is_left {
            // sibling is left, so hash(sib || node)
            node = hashv(&[sib, &node]).to_bytes();
            msg!("[{}] left: hash(sib,node) = {}", i, hex::encode(node));
        } else {
            // sibling is right, so hash(node || sib)
            node = hashv(&[&node, sib]).to_bytes();
            msg!("[{}] right: hash(node,sib) = {}", i, hex::encode(node));
        }
    }

    msg!("Computed root: {}", hex::encode(node));
    msg!(
        "Expected root: {}",
        hex::encode(ctx.accounts.epoch.merkle_root)
    );

    require!(
        node == ctx.accounts.epoch.merkle_root,
        CustomErrorCode::InvalidMerkleProof
    );

    // mint tokens (wYLDS) to user
    let seeds: &[&[u8]] = &[b"mint_authority", &[ctx.bumps.mint_authority]];
    let signer = &[&seeds[..]];
    let cpi_accounts = MintTo {
        mint: ctx.accounts.mint.to_account_info(),
        to: ctx.accounts.user_mint_token_account.to_account_info(),
        authority: ctx.accounts.mint_authority.to_account_info(),
    };
    token::mint_to(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            cpi_accounts,
            signer,
        ),
        amount,
    )?;

    msg!("Emitting RewardsClaimed");
    emit!(RewardsClaimed {
        user: ctx.accounts.user.key(),
        epoch: ctx.accounts.epoch.index,
        amount,
        mint: ctx.accounts.mint.key(),
        vault: ctx.accounts.config.vault,
    });
    msg!("Emitted RewardsClaimed");

    Ok(())
}

// Allows an external program (specified in config) to mint tokens to a destination account
pub fn external_program_mint(ctx: Context<ExternalProgramMint>, amount: u64) -> Result<()> {
    let config = &ctx.accounts.config;

    // Verify admin is a rewards administrator
    // Note: admin is not a Signer here (it's just an AccountInfo whose pubkey we check)
    // The PDA (external_mint_authority) is the actual signer of the CPI
    require!(
        config.rewards_administrators.contains(&ctx.accounts.admin.key()),
        CustomErrorCode::InvalidRewardsAdministrator
    );


    // The external_mint_authority PDA verification happens automatically
    // via the seeds constraint. The constraint ensures:
    // 1. The PDA address matches derivation from [b"external_mint_authority"] + allowed_external_mint_program
    // 2. The PDA is properly signed (only possible if called via CPI from allowed_external_mint_program)
    // Mint tokens using the mint_authority PDA
    let seeds: &[&[u8]] = &[b"mint_authority", &[ctx.bumps.mint_authority]];
    let signer = &[&seeds[..]];
    let cpi_accounts = MintTo {
        mint: ctx.accounts.mint.to_account_info(),
        to: ctx.accounts.destination.to_account_info(),
        authority: ctx.accounts.mint_authority.to_account_info(),
    };
    token::mint_to(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            cpi_accounts,
            signer,
        ),
        amount,
    )?;

    msg!("Emitting ExternalProgramMintEvent");
    emit!(ExternalProgramMintEvent {
        admin: ctx.accounts.admin.key(),
        destination: ctx.accounts.destination.key(),
        amount: amount,
        mint: ctx.accounts.mint.key(),
        vault: ctx.accounts.config.vault,
    });
    msg!("Emitted ExternalProgramMintEvent");

    Ok(())
}

// create a function called by program update authority to update the vault token account
pub fn update_vault_token_account(
    ctx: Context<UpdateVaultTokenAccount>,
) -> Result<()> {   
    // Validate that the signer is the program's update authority
    validate_program_update_authority(&ctx.accounts.program_data, &ctx.accounts.signer)?;

    let config = &mut ctx.accounts.config;
    config.vault_authority = ctx.accounts.vault_token_account.owner;

    let vault_token_account_config = &mut ctx.accounts.vault_token_account_config;
    vault_token_account_config.vault_token_account = ctx.accounts.vault_token_account.key();

    msg!("Vault token authority updated to: {}", ctx.accounts.vault_token_account.owner.key());
    msg!("Vault token account updated to: {}", ctx.accounts.vault_token_account.key());
    Ok(())
}

pub fn sweep_redeem_vault_funds(
    ctx: Context<SweepRedeemVaultFunds>,
    amount: u64,
) -> Result<()> {
    // Validate the signer is a rewards administrator
    require!(
        ctx.accounts
            .config
            .rewards_administrators
            .contains(&ctx.accounts.signer.key()),
        CustomErrorCode::InvalidRewardsAdministrator
    );

    require!(amount > 0, CustomErrorCode::InvalidAmount);

    let vault_balance = ctx.accounts.redeem_vault_token_account.amount;
    require!(
        vault_balance >= amount, 
        CustomErrorCode::InsufficientRedeemVaultFunds
    );

    let seeds: &[&[u8]] = &[
        b"redeem_vault_authority",
        &[ctx.bumps.redeem_vault_authority],
    ];
    let signer = &[&seeds[..]];
    // transfer from redeem vault to the vault token account
    // the vault token account is owned by the vault authority which is set in config
    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.redeem_vault_token_account.to_account_info(),
                to: ctx.accounts.vault_token_account.to_account_info(),
                authority: ctx.accounts.redeem_vault_authority.to_account_info(),
            },
            signer,
        ),
        amount
    )?;

    msg!("Emitting SweepRedeemVaultEvent");
    emit!(SweepRedeemVaultEvent {
        admin: ctx.accounts.signer.key(),
        destination: ctx.accounts.vault_token_account.key(),
        amount: amount,
        vault: ctx.accounts.redeem_vault_token_account.mint,
    });
    msg!("Emitted SweepRedeemVaultEvent");

    Ok(())
}

pub fn set_vault_token_account_config(ctx: Context<SetVaultTokenAccountConfig>) -> Result<()> {
    // Validate that the signer is the program's update authority
    validate_program_update_authority(&ctx.accounts.program_data, &ctx.accounts.signer)?;

    // Write the new value
    let vault_token_account_config = &mut ctx.accounts.vault_token_account_config;
    vault_token_account_config.vault_token_account = ctx.accounts.vault_token_account.key();
    vault_token_account_config.bump = ctx.bumps.vault_token_account_config;

    Ok(())
}
