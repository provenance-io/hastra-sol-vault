use crate::account_structs::*;
use crate::error::*;
use crate::events::*;
use crate::guard::validate_program_update_authority;
use crate::state::{StakeRewardConfig, MAX_ADMINISTRATORS};
use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::{get_return_data, invoke};
use anchor_lang::solana_program::program_error::ProgramError;
use anchor_lang::solana_program::system_instruction;
use anchor_spl::token::spl_token::instruction::AuthorityType;
use anchor_spl::token::{self, Burn, MintTo, Transfer};
use chainlink_data_streams_report::feed_id::ID as FeedId;
use chainlink_data_streams_report::report::v7::ReportDataV7;
use chainlink_solana_data_streams::VerifierInstructions;
use num_traits::ToPrimitive;

pub fn initialize(
    ctx: Context<Initialize>,
    freeze_administrators: Vec<Pubkey>,
    rewards_administrators: Vec<Pubkey>,
) -> Result<()> {
    validate_program_update_authority(&ctx.accounts.program_data, &ctx.accounts.signer)?;
    require!(
        freeze_administrators.len() <= MAX_ADMINISTRATORS,
        CustomErrorCode::TooManyAdministrators
    );
    require!(
        rewards_administrators.len() <= MAX_ADMINISTRATORS,
        CustomErrorCode::TooManyAdministrators
    );
    require!(
        ctx.accounts.vault_token_mint.key() != ctx.accounts.mint.key(),
        CustomErrorCode::VaultAndMintCannotBeSame
    );

    let config = &mut ctx.accounts.stake_config;
    config.vault = ctx.accounts.vault_token_mint.key();
    config.mint = ctx.accounts.mint.key();
    config.unbonding_period = 0; // DEPRECATED: unbonding period removed in v0.0.5
    config.freeze_administrators = freeze_administrators;
    config.rewards_administrators = rewards_administrators;
    config.bump = ctx.bumps.stake_config;
    config.paused = false;

    let stake_vault_token_account_config = &mut ctx.accounts.stake_vault_token_account_config;
    stake_vault_token_account_config.vault_token_account = ctx.accounts.vault_token_account.key();
    stake_vault_token_account_config.vault_authority = ctx.accounts.vault_authority.key();
    stake_vault_token_account_config.bump = ctx.bumps.stake_vault_token_account_config;

    // The vault token account must be owned by the program-derived address (PDA)
    // and is the token account that holds the deposited vault tokens (e.g., wYLDS).
    // This ensures that only the program can move tokens out of this account.
    // Only set vault token account to PDA authority if it's not already set to vault_authority
    if ctx.accounts.vault_token_account.owner == ctx.accounts.signer.key() {
        let seeds: &[&[u8]] = &[b"vault_authority", &[ctx.bumps.vault_authority]];
        let signer = &[&seeds[..]];
        token::set_authority(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                token::SetAuthority {
                    account_or_mint: ctx.accounts.vault_token_account.to_account_info(),
                    current_authority: ctx.accounts.signer.to_account_info(),
                },
                signer,
            ),
            AuthorityType::AccountOwner,
            Some(ctx.accounts.vault_authority.key()),
        )?;
    }
    Ok(())
}

pub fn pause(ctx: Context<Pause>, pause: bool) -> Result<()> {
    let config = &ctx.accounts.stake_config;
    let signer = ctx.accounts.signer.key();

    // Verify signer is a freeze administrator
    require!(
        config.freeze_administrators.contains(&signer),
        CustomErrorCode::UnauthorizedFreezeAdministrator
    );

    let config = &mut ctx.accounts.stake_config;
    config.paused = pause;

    msg!("Protocol paused: {}", pause);

    Ok(())
}

pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
    require!(amount > 0, CustomErrorCode::InvalidAmount);
    require!(
        !ctx.accounts.stake_config.paused,
        CustomErrorCode::ProtocolPaused
    );

    let total_assets = ctx.accounts.vault_token_account.amount;
    let total_shares = ctx.accounts.mint.supply;

    msg!("Current total_assets: {}", total_assets);
    msg!("Current total_shares: {}", total_shares);
    msg!("Deposit amount: {}", amount);

    // Chainlink price-based share calculation.
    // price convention: price = (wYLDS per 1 PRIME) * price_scale
    // Formula: shares = deposit_wYLDS * price_scale / price
    let price_config = &ctx.accounts.stake_price_config;
    let current_time = Clock::get()?.unix_timestamp;
    require!(
        price_config.price_timestamp > 0,
        CustomErrorCode::PriceNotInitialized
    );
    require!(
        current_time
            .checked_sub(price_config.price_timestamp)
            .ok_or(CustomErrorCode::Overflow)?
            <= price_config.price_max_staleness,
        CustomErrorCode::PriceTooStale
    );
    require!(price_config.price > 0, CustomErrorCode::PriceNotInitialized);

    let shares_to_mint = (amount as u128)
        .checked_mul(price_config.price_scale as u128)
        .ok_or(CustomErrorCode::Overflow)?
        .checked_div(price_config.price as u128)
        .ok_or(CustomErrorCode::DivisionByZero)?;
    msg!("Shares to mint calculated: {}", shares_to_mint);

    // Require that user receives at least some shares
    require!(shares_to_mint > 0, CustomErrorCode::DepositTooSmall);

    let shares_to_mint_u64: u64 = shares_to_mint
        .try_into()
        .map_err(|_| CustomErrorCode::Overflow)?;

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
        shares_to_mint_u64,
    )?;

    let result_total_assets = total_assets
        .checked_add(amount)
        .ok_or(CustomErrorCode::Overflow)?;
    let result_total_shares = total_shares
        .checked_add(shares_to_mint_u64)
        .ok_or(CustomErrorCode::Overflow)?;
    let totals_last_update_slot = Clock::get()?.slot;

    msg!("Emitting DepositEvent");
    emit!(DepositEvent {
        user: ctx.accounts.signer.key(),
        deposit_amount: amount,
        minted_amount: shares_to_mint_u64,
        mint: ctx.accounts.mint.key(),
        mint_supply: ctx.accounts.mint.supply,
        vault: ctx.accounts.vault_token_account.key(),
        vault_balance: ctx.accounts.vault_token_account.amount,
        total_assets: result_total_assets,
        total_shares: result_total_shares,
        totals_last_update_slot,
    });
    msg!("Emitted DepositEvent");

    Ok(())
}

// Redeem stake tokens (PRIME) for vault tokens (wYLDS).
// Burns the user's PRIME and transfers the proportional share of wYLDS from the vault.
// Any legacy unbonding ticket (from the old two-step flow) is automatically closed
// and rent returned to the user when the optional ticket account is provided.
pub fn redeem(ctx: Context<Redeem>, amount: u64) -> Result<()> {
    msg!("Starting redeem process");
    require!(amount > 0, CustomErrorCode::InvalidAmount);
    require!(
        !ctx.accounts.stake_config.paused,
        CustomErrorCode::ProtocolPaused
    );

    // Chainlink price-based asset calculation.
    // price convention: price = (wYLDS per 1 PRIME) * price_scale
    // Formula: wYLDS_returned = shares_burned * price / price_scale
    // Check price validity before user balance so oracle failures surface clearly.
    let price_config = &ctx.accounts.stake_price_config;
    let current_time = Clock::get()?.unix_timestamp;
    require!(
        price_config.price_timestamp > 0,
        CustomErrorCode::PriceNotInitialized
    );
    require!(
        current_time
            .checked_sub(price_config.price_timestamp)
            .ok_or(CustomErrorCode::Overflow)?
            <= price_config.price_max_staleness,
        CustomErrorCode::PriceTooStale
    );
    require!(price_config.price > 0, CustomErrorCode::PriceNotInitialized);

    let user_share_mint_balance = ctx.accounts.user_mint_token_account.amount;
    require!(
        amount <= user_share_mint_balance,
        CustomErrorCode::InsufficientBalance
    );

    let total_assets = ctx.accounts.vault_token_account.amount;
    let total_shares = ctx.accounts.mint.supply;
    msg!("total_assets: {}", total_assets);
    msg!("total_shares: {}", total_shares);
    msg!("redeem amount (shares): {}", amount);

    let amount_to_withdraw = (amount as u128)
        .checked_mul(price_config.price as u128)
        .ok_or(CustomErrorCode::Overflow)?
        .checked_div(price_config.price_scale as u128)
        .ok_or(CustomErrorCode::DivisionByZero)?;

    msg!("Amount to withdraw calculated: {}", amount_to_withdraw);

    // Guard against dust amounts rounding down to zero
    require!(amount_to_withdraw > 0, CustomErrorCode::InvalidAmount);

    let amount_to_withdraw_u64: u64 = amount_to_withdraw
        .try_into()
        .map_err(|_| CustomErrorCode::Overflow)?;

    require!(
        ctx.accounts.vault_token_account.amount >= amount_to_withdraw_u64,
        CustomErrorCode::InsufficientVaultBalance
    );

    let burn_accounts = Burn {
        mint: ctx.accounts.mint.to_account_info(),
        from: ctx.accounts.user_mint_token_account.to_account_info(),
        authority: ctx.accounts.signer.to_account_info(),
    };
    token::burn(
        CpiContext::new(ctx.accounts.token_program.to_account_info(), burn_accounts),
        amount,
    )?;

    let seeds: &[&[u8]] = &[b"vault_authority", &[ctx.bumps.vault_authority]];
    let signer = &[&seeds[..]];
    let transfer_accounts = Transfer {
        from: ctx.accounts.vault_token_account.to_account_info(),
        to: ctx.accounts.user_vault_token_account.to_account_info(),
        authority: ctx.accounts.vault_authority.to_account_info(),
    };
    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            transfer_accounts,
            signer,
        ),
        amount_to_withdraw_u64,
    )?;

    let result_total_assets = total_assets
        .checked_sub(amount_to_withdraw_u64)
        .ok_or(CustomErrorCode::Overflow)?;
    let result_total_shares = total_shares
        .checked_sub(amount)
        .ok_or(CustomErrorCode::Overflow)?;
    let totals_last_update_slot = Clock::get()?.slot;

    msg!("Emitting RedeemEvent");
    emit!(RedeemEvent {
        user: ctx.accounts.signer.key(),
        mint: ctx.accounts.mint.key(),
        requested_mint_amount: amount,
        mint_supply: ctx.accounts.mint.supply,
        vault: ctx.accounts.vault_token_account.key(),
        redeemed_vault_amount: amount_to_withdraw_u64,
        vault_balance: ctx.accounts.vault_token_account.amount,
        shares_burned: amount,
        total_assets: result_total_assets,
        total_shares: result_total_shares,
        totals_last_update_slot,
    });
    msg!("Emitted RedeemEvent");

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

    let config = &mut ctx.accounts.stake_config;

    require!(
        new_administrators.len() <= MAX_ADMINISTRATORS,
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

    let config = &mut ctx.accounts.stake_config;

    require!(
        new_administrators.len() <= MAX_ADMINISTRATORS,
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
    let config = &ctx.accounts.stake_config;
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
    let config = &ctx.accounts.stake_config;
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

pub fn publish_rewards(ctx: Context<PublishRewards>, id: u32, amount: u64) -> Result<()> {
    require!(
        !ctx.accounts.stake_config.paused,
        CustomErrorCode::ProtocolPaused
    );
    require!(
        ctx.accounts
            .stake_config
            .rewards_administrators
            .contains(&ctx.accounts.admin.key()),
        CustomErrorCode::InvalidRewardsAdministrator
    );
    require!(amount > 0, CustomErrorCode::InvalidAmount);

    // Ensure StakeRewardConfig.bump is set to the PDA bump used by Anchor.
    // This assignment is idempotent and does not rely on any sentinel value.
    ctx.accounts.stake_reward_config.bump = ctx.bumps.stake_reward_config;

    // Lazily initialize defaults for any newly-added fields (for realloc-based migrations).
    let config = &mut ctx.accounts.stake_reward_config;
    if config.max_reward_bps == 0 {
        config.max_reward_bps = StakeRewardConfig::DEFAULT_BPS;
    }
    if config.max_period_rewards == 0 {
        config.max_period_rewards = StakeRewardConfig::DEFAULT_MAX_PERIOD_REWARDS;
    }
    if config.reward_period_seconds <= 0 {
        config.reward_period_seconds = StakeRewardConfig::DEFAULT_REWARD_PERIOD_SECONDS;
    }
    if config.max_total_rewards == 0 {
        config.max_total_rewards = StakeRewardConfig::DEFAULT_MAX_TOTAL_REWARDS;
    }

    // Enforce reward cap: amount must not exceed max_reward_bps % of current total_assets.
    // Skip only when the vault is truly empty (bootstrap) — cap applies whenever assets exist.
    let total_assets = ctx.accounts.vault_token_account.amount;
    if total_assets > 0 {
        let effective_bps = config.max_reward_bps;
        let max_allowed = (total_assets as u128)
            .checked_mul(effective_bps as u128)
            .and_then(|v| v.checked_div(StakeRewardConfig::MAX_BPS as u128))
            .and_then(|v| v.to_u64())
            .ok_or(CustomErrorCode::Overflow)?;
        require!(
            amount <= max_allowed,
            CustomErrorCode::RewardExceedsMaxDelta
        );
    }

    // Absolute per-call cap.
    require!(
        amount <= config.max_period_rewards,
        CustomErrorCode::ExceedsPeriodRewardCap
    );

    // Cooldown between reward publications (first publication is always allowed).
    let now = Clock::get()?.unix_timestamp;
    if config.last_reward_distributed_at > 0 {
        let next_allowed_at = config
            .last_reward_distributed_at
            .checked_add(config.reward_period_seconds)
            .ok_or(CustomErrorCode::Overflow)?;
        require!(
            now >= next_allowed_at,
            CustomErrorCode::RewardCooldownNotElapsed
        );
    }

    // Lifetime cap.
    let next_total = config
        .total_rewards_distributed
        .checked_add(amount)
        .ok_or(CustomErrorCode::Overflow)?;
    require!(
        next_total <= config.max_total_rewards,
        CustomErrorCode::ExceedsLifetimeRewardCap
    );

    // Initialize the reward record
    let reward_record = &mut ctx.accounts.reward_record;
    reward_record.id = id;
    reward_record.amount = amount;
    reward_record.published_at = Clock::get()?.unix_timestamp;
    reward_record.bump = ctx.bumps.reward_record;

    let stake_config = &ctx.accounts.stake_config;

    // Prepare PDA signer for CPI call
    // This PDA can only be signed by vault-stake program
    let seeds: &[&[u8]] = &[
        b"external_mint_authority",
        &[ctx.bumps.external_mint_authority],
    ];
    let signer = &[&seeds[..]];

    // CPI into vault-mint::external_program_mint.
    // calling_program (this_program) and allowed_external_mint_programs are the two new
    // accounts required by vault-mint's updated ExternalProgramMint context; they allow
    // vault-mint to verify caller identity without a fixed single-program config field.
    let cpi_program = ctx.accounts.mint_program.to_account_info();
    let cpi_accounts = vault_mint::cpi::accounts::ExternalProgramMint {
        config: ctx.accounts.mint_config.to_account_info(),
        calling_program: ctx.accounts.this_program.to_account_info(),
        external_mint_authority: ctx.accounts.external_mint_authority.to_account_info(),
        mint: ctx.accounts.rewards_mint.to_account_info(),
        mint_authority: ctx.accounts.rewards_mint_authority.to_account_info(),
        admin: ctx.accounts.admin.to_account_info(),
        destination: ctx.accounts.vault_token_account.to_account_info(),
        allowed_external_mint_programs: ctx
            .accounts
            .vault_mint_allowed_external_programs
            .to_account_info(),
        token_program: ctx.accounts.token_program.to_account_info(),
    };
    let cpi_ctx = CpiContext::new_with_signer(cpi_program, cpi_accounts, signer);
    vault_mint::cpi::external_program_mint(cpi_ctx, amount)?;

    // Update guard state after successful mint CPI.
    config.last_reward_distributed_at = now;
    config.total_rewards_distributed = next_total;

    // reload the vault token account to get the updated amount for publishing the event
    ctx.accounts.vault_token_account.reload()?;

    let totals_last_update_slot = Clock::get()?.slot;

    msg!("Publishing rewards for id: {} for amount: {}", id, amount);
    msg!("Emitting RewardsPublished");
    emit!(RewardsPublished {
        admin: ctx.accounts.admin.key(),
        amount,
        mint_program: ctx.accounts.mint_program.key(),
        vault_token_account: ctx.accounts.vault_token_account.key(),
        mint: stake_config.mint,
        vault: stake_config.vault,
        total_assets: ctx.accounts.vault_token_account.amount,
        total_shares: ctx.accounts.mint.supply,
        totals_last_update_slot,
        id,
    });
    msg!("Emitted RewardsPublished");

    Ok(())
}

/// FOR TESTING ONLY — directly writes price and price_timestamp into StakePriceConfig.
/// Requires program upgrade authority. Intended for localnet test environments where
/// the Chainlink verifier is not available. DO NOT USE IN PRODUCTION.
#[cfg(feature = "testing")]
pub fn set_price_for_testing(
    ctx: Context<SetPriceForTesting>,
    price: i128,
    price_timestamp: i64,
) -> Result<()> {
    validate_program_update_authority(&ctx.accounts.program_data, &ctx.accounts.signer)?;
    let config = &mut ctx.accounts.stake_price_config;
    config.price = price;
    config.price_timestamp = price_timestamp;
    msg!(
        "set_price_for_testing: price={}, price_timestamp={}",
        price,
        price_timestamp
    );
    Ok(())
}

/// Convert shares to underlying assets using the stored Chainlink price.
/// assets = shares * price / price_scale
/// Returns value via return_data for efficient CPI access
pub fn shares_to_assets(ctx: Context<ConversionView>, shares: u64) -> Result<u64> {
    let price_config = &ctx.accounts.stake_price_config;
    require!(price_config.price > 0, CustomErrorCode::PriceNotInitialized);

    let assets = (shares as u128)
        .checked_mul(price_config.price as u128)
        .ok_or(CustomErrorCode::Overflow)?
        .checked_div(price_config.price_scale as u128)
        .ok_or(CustomErrorCode::DivisionByZero)? as u64;

    msg!("shares_to_assets: {} shares = {} assets", shares, assets);

    anchor_lang::solana_program::program::set_return_data(&assets.to_le_bytes());

    Ok(assets)
}

/// Convert underlying assets to shares using the stored Chainlink price.
/// shares = assets * price_scale / price
/// Returns value via return_data for efficient CPI access
pub fn assets_to_shares(ctx: Context<ConversionView>, assets: u64) -> Result<u64> {
    let price_config = &ctx.accounts.stake_price_config;
    require!(price_config.price > 0, CustomErrorCode::PriceNotInitialized);

    let shares = (assets as u128)
        .checked_mul(price_config.price_scale as u128)
        .ok_or(CustomErrorCode::Overflow)?
        .checked_div(price_config.price as u128)
        .ok_or(CustomErrorCode::DivisionByZero)? as u64;

    msg!("assets_to_shares: {} assets = {} shares", assets, shares);

    anchor_lang::solana_program::program::set_return_data(&shares.to_le_bytes());

    Ok(shares)
}

/// Initializes the StakePriceConfig PDA.
/// Must be called once after program upgrade, before any deposit or redeem.
/// Only callable by the program upgrade authority.
pub fn initialize_price_config(
    ctx: Context<InitializePriceConfig>,
    chainlink_program: Pubkey,
    chainlink_verifier_account: Pubkey,
    chainlink_access_controller: Pubkey,
    feed_id: [u8; 32],
    price_scale: u64,
    price_max_staleness: i64,
) -> Result<()> {
    validate_program_update_authority(&ctx.accounts.program_data, &ctx.accounts.signer)?;

    let config = &mut ctx.accounts.stake_price_config;
    config.chainlink_program = chainlink_program;
    config.chainlink_verifier_account = chainlink_verifier_account;
    config.chainlink_access_controller = chainlink_access_controller;
    config.feed_id = feed_id;
    config.price_scale = price_scale;
    config.price_max_staleness = price_max_staleness;
    config.price = 0;
    config.price_timestamp = 0;
    config.bump = ctx.bumps.stake_price_config;

    msg!("StakePriceConfig initialized");
    msg!("chainlink_program: {}", chainlink_program);
    msg!("price_scale: {}", price_scale);
    msg!("price_max_staleness: {}s", price_max_staleness);

    Ok(())
}

/// Updates configuration parameters on an existing StakePriceConfig.
/// Only callable by the program upgrade authority.
/// Does not reset the stored price or price_timestamp.
pub fn update_price_config(
    ctx: Context<UpdatePriceConfig>,
    chainlink_program: Pubkey,
    chainlink_verifier_account: Pubkey,
    chainlink_access_controller: Pubkey,
    feed_id: [u8; 32],
    price_scale: u64,
    price_max_staleness: i64,
) -> Result<()> {
    validate_program_update_authority(&ctx.accounts.program_data, &ctx.accounts.signer)?;

    let config = &mut ctx.accounts.stake_price_config;
    config.chainlink_program = chainlink_program;
    config.chainlink_verifier_account = chainlink_verifier_account;
    config.chainlink_access_controller = chainlink_access_controller;
    config.feed_id = feed_id;
    config.price_scale = price_scale;
    config.price_max_staleness = price_max_staleness;

    msg!("StakePriceConfig updated");
    msg!("chainlink_program: {}", chainlink_program);
    msg!("price_scale: {}", price_scale);
    msg!("price_max_staleness: {}s", price_max_staleness);

    Ok(())
}

/// Migrates the StakeRewardConfig PDA for the given StakeConfig.
/// Explicitly sets `max_reward_bps` to the provided value (subject to MAX_BPS validation).
/// This is a one-time migration step required after program upgrade as the config schema has changed.
/// Only callable by the program upgrade authority.
pub fn migrate_reward_config(
    ctx: Context<MigrateRewardConfig>,
    max_reward_bps: u64,
    max_period_rewards: u64,
    reward_period_seconds: i64,
    max_total_rewards: u64,
) -> Result<()> {
    validate_program_update_authority(&ctx.accounts.program_data, &ctx.accounts.signer)?;
    require!(
        max_reward_bps > 0 && max_reward_bps <= StakeRewardConfig::MAX_BPS,
        CustomErrorCode::InvalidMaxRewardBps
    );
    require!(
        max_period_rewards > 0,
        CustomErrorCode::InvalidMaxPeriodRewards
    );
    require!(
        reward_period_seconds > 0,
        CustomErrorCode::InvalidRewardPeriodSeconds
    );
    require!(
        max_total_rewards > 0,
        CustomErrorCode::InvalidMaxTotalRewards
    );

    const LEGACY_STAKE_REWARD_CONFIG_LEN: usize = 17; // discriminator + max_reward_bps + bump
    let stake_reward_config_info = ctx.accounts.stake_reward_config.to_account_info();
    let old_len = stake_reward_config_info.data_len();

    // Top up rent before realloc so account growth is deterministic.
    if old_len < StakeRewardConfig::LEN {
        let rent = Rent::get()?;
        let required_lamports = rent.minimum_balance(StakeRewardConfig::LEN);
        let current_lamports = stake_reward_config_info.lamports();
        if current_lamports < required_lamports {
            let delta = required_lamports
                .checked_sub(current_lamports)
                .ok_or(CustomErrorCode::Overflow)?;
            invoke(
                &system_instruction::transfer(
                    &ctx.accounts.signer.key(),
                    &stake_reward_config_info.key(),
                    delta,
                ),
                &[
                    ctx.accounts.signer.to_account_info(),
                    stake_reward_config_info.clone(),
                    ctx.accounts.system_program.to_account_info(),
                ],
            )?;
        }
        stake_reward_config_info.realloc(StakeRewardConfig::LEN, false)?;
    }

    let mut migrated_config = StakeRewardConfig {
        max_reward_bps,
        max_period_rewards,
        reward_period_seconds,
        last_reward_distributed_at: 0,
        max_total_rewards,
        total_rewards_distributed: 0,
        bump: 0,
    };

    let stake_reward_config_data = stake_reward_config_info.try_borrow_data()?;
    if stake_reward_config_data.len() < 8 {
        return Err(ProgramError::InvalidAccountData.into());
    }
    if &stake_reward_config_data[0..8] != StakeRewardConfig::DISCRIMINATOR {
        return Err(ProgramError::InvalidAccountData.into());
    }

    if old_len == StakeRewardConfig::LEN {
        let mut data_slice: &[u8] = stake_reward_config_data.as_ref();
        let current_config = StakeRewardConfig::try_deserialize(&mut data_slice)
            .map_err(|_| ProgramError::InvalidAccountData)?;
        migrated_config.max_period_rewards = if current_config.max_period_rewards > 0 {
            current_config.max_period_rewards
        } else {
            max_period_rewards
        };
        migrated_config.reward_period_seconds = if current_config.reward_period_seconds > 0 {
            current_config.reward_period_seconds
        } else {
            reward_period_seconds
        };
        migrated_config.max_total_rewards = if current_config.max_total_rewards > 0 {
            current_config.max_total_rewards
        } else {
            max_total_rewards
        };
        migrated_config.last_reward_distributed_at = current_config.last_reward_distributed_at;
        migrated_config.total_rewards_distributed = current_config.total_rewards_distributed;
        migrated_config.bump = current_config.bump;
    } else if old_len == LEGACY_STAKE_REWARD_CONFIG_LEN {
        // Legacy layout only had `max_reward_bps` + `bump`, so all new fields are initialized
        // from instruction arguments while preserving bump.
        migrated_config.bump = stake_reward_config_data[16];
    } else {
        return Err(ProgramError::InvalidAccountData.into());
    }
    drop(stake_reward_config_data);

    let mut stake_reward_config_data_mut = stake_reward_config_info.try_borrow_mut_data()?;
    let mut out_slice: &mut [u8] = stake_reward_config_data_mut.as_mut();
    migrated_config
        .try_serialize(&mut out_slice)
        .map_err(|_| ProgramError::InvalidAccountData)?;

    msg!(
        "StakeRewardConfig migrated: old_len={}, max_reward_bps={}, max_period_rewards={}, reward_period_seconds={}, max_total_rewards={}, bump={}",
        old_len,
        migrated_config.max_reward_bps,
        migrated_config.max_period_rewards,
        migrated_config.reward_period_seconds,
        migrated_config.max_total_rewards,
        migrated_config.bump
    );
    Ok(())
}

/// Updates max_reward_bps on an existing StakeRewardConfig.
/// Only callable by the program upgrade authority.
pub fn update_max_reward_bps(ctx: Context<UpdateMaxRewardBps>, new_bps: u64) -> Result<()> {
    validate_program_update_authority(&ctx.accounts.program_data, &ctx.accounts.signer)?;
    require!(
        new_bps > 0 && new_bps <= StakeRewardConfig::MAX_BPS,
        CustomErrorCode::InvalidMaxRewardBps
    );

    let config = &mut ctx.accounts.stake_reward_config;
    let old_bps = config.max_reward_bps;
    config.max_reward_bps = new_bps;

    emit!(MaxRewardBpsUpdated {
        admin: ctx.accounts.signer.key(),
        old_bps,
        new_bps,
        stake_config: ctx.accounts.stake_config.key(),
    });

    msg!("max_reward_bps updated: {} -> {}", old_bps, new_bps);
    Ok(())
}

pub fn update_max_period_rewards(ctx: Context<UpdateMaxPeriodRewards>, new_cap: u64) -> Result<()> {
    validate_program_update_authority(&ctx.accounts.program_data, &ctx.accounts.signer)?;
    require!(new_cap > 0, CustomErrorCode::InvalidMaxPeriodRewards);

    let config = &mut ctx.accounts.stake_reward_config;
    let old_value = config.max_period_rewards;
    config.max_period_rewards = new_cap;

    emit!(MaxPeriodRewardsUpdated {
        admin: ctx.accounts.signer.key(),
        old_value,
        new_value: new_cap,
        stake_config: ctx.accounts.stake_config.key(),
    });

    msg!("max_period_rewards updated: {} -> {}", old_value, new_cap);
    Ok(())
}

/// Updates reward_period_seconds on an existing StakeRewardConfig.
/// Only callable by the program upgrade authority.
pub fn update_reward_period_seconds(
    ctx: Context<UpdateRewardPeriodSeconds>,
    new_seconds: i64,
) -> Result<()> {
    validate_program_update_authority(&ctx.accounts.program_data, &ctx.accounts.signer)?;
    require!(new_seconds > 0, CustomErrorCode::InvalidRewardPeriodSeconds);

    let config = &mut ctx.accounts.stake_reward_config;
    let old_value = config.reward_period_seconds;
    config.reward_period_seconds = new_seconds;

    emit!(RewardPeriodSecondsUpdated {
        admin: ctx.accounts.signer.key(),
        old_value,
        new_value: new_seconds,
        stake_config: ctx.accounts.stake_config.key(),
    });

    msg!(
        "reward_period_seconds updated: {} -> {}",
        old_value,
        new_seconds
    );
    Ok(())
}

/// Updates max_total_rewards on an existing StakeRewardConfig.
/// Only callable by the program upgrade authority.
pub fn update_max_total_rewards(ctx: Context<UpdateMaxTotalRewards>, new_cap: u64) -> Result<()> {
    validate_program_update_authority(&ctx.accounts.program_data, &ctx.accounts.signer)?;
    let distributed = ctx.accounts.stake_reward_config.total_rewards_distributed;
    require!(
        new_cap > 0 && new_cap >= distributed,
        CustomErrorCode::InvalidMaxTotalRewards
    );

    let config = &mut ctx.accounts.stake_reward_config;
    let old_value = config.max_total_rewards;
    config.max_total_rewards = new_cap;

    emit!(MaxTotalRewardsUpdated {
        admin: ctx.accounts.signer.key(),
        old_value,
        new_value: new_cap,
        stake_config: ctx.accounts.stake_config.key(),
    });

    msg!("max_total_rewards updated: {} -> {}", old_value, new_cap);
    Ok(())
}

/// Submits a signed Chainlink Data Streams report to the on-chain verifier via CPI.
/// On successful verification:
///   1. The report's feed ID is checked against the configured feed ID.
///   2. The report's validity window is checked (valid_from_timestamp <= now <= expires_at).
///   3. exchange_rate is stored as the new price and price_timestamp is updated.
/// Only callable by rewards administrators.
pub fn verify_price(ctx: Context<VerifyPrice>, signed_report: Vec<u8>) -> Result<()> {
    // Authorization: signer must be a rewards administrator
    require!(
        ctx.accounts
            .stake_config
            .rewards_administrators
            .contains(&ctx.accounts.signer.key()),
        CustomErrorCode::InvalidRewardsAdministrator
    );

    let price_config = &ctx.accounts.stake_price_config;

    // Validate that passed accounts match the stored config
    require!(
        ctx.accounts.chainlink_program.key() == price_config.chainlink_program,
        CustomErrorCode::InvalidAuthority
    );
    require!(
        ctx.accounts.chainlink_verifier_account.key() == price_config.chainlink_verifier_account,
        CustomErrorCode::InvalidAuthority
    );
    require!(
        ctx.accounts.chainlink_access_controller.key() == price_config.chainlink_access_controller,
        CustomErrorCode::InvalidAuthority
    );

    // Build and invoke the Chainlink verify CPI
    let chainlink_ix = VerifierInstructions::verify(
        &ctx.accounts.chainlink_program.key(),
        &ctx.accounts.chainlink_verifier_account.key(),
        &ctx.accounts.chainlink_access_controller.key(),
        &ctx.accounts.signer.key(),
        &ctx.accounts.chainlink_config_account.key(),
        signed_report,
    );

    invoke(
        &chainlink_ix,
        &[
            ctx.accounts.chainlink_verifier_account.to_account_info(),
            ctx.accounts.chainlink_access_controller.to_account_info(),
            ctx.accounts.signer.to_account_info(),
            ctx.accounts.chainlink_config_account.to_account_info(),
        ],
    )?;

    // Decode the verified report from return data
    let (_, return_data) = get_return_data().ok_or(CustomErrorCode::ChainlinkVerifyFailed)?;
    let report =
        ReportDataV7::decode(&return_data).map_err(|_| CustomErrorCode::ChainlinkVerifyFailed)?;

    let current_time = Clock::get()?.unix_timestamp;

    msg!(
        "Chainlink report verified - current_time: {}, valid_from_timestamp: {}, expires_at: {}",
        current_time,
        report.valid_from_timestamp,
        report.expires_at
    );
    // Validate the report is within its valid time window
    require!(
        current_time >= i64::from(report.valid_from_timestamp),
        CustomErrorCode::FutureReportValidFromTimestamp
    );
    require!(
        current_time <= i64::from(report.expires_at),
        CustomErrorCode::ReportStale
    );

    // Validate the report is for the expected feed
    require!(
        report.feed_id == FeedId(ctx.accounts.stake_price_config.feed_id),
        CustomErrorCode::InvalidFeedId
    );

    // Store price — exchange_rate is an i192-equivalent BigInt; i128 covers all realistic
    // token pair prices (up to ~1.7e38 with 18 decimal precision).
    let price_i128 = report
        .exchange_rate
        .to_i128()
        .ok_or(CustomErrorCode::Overflow)?;

    let price_config = &mut ctx.accounts.stake_price_config;
    price_config.price = price_i128;
    price_config.price_timestamp = current_time;

    msg!("Price verified and stored");
    msg!("price: {}", price_config.price);
    msg!("price_timestamp: {}", price_config.price_timestamp);
    msg!("expires_at: {}", report.expires_at);

    msg!("Emitting PriceVerifiedEvent");
    emit!(PriceVerifiedEvent {
        verifier: ctx.accounts.signer.key(),
        feed_id: report.feed_id.0,
        price: price_config.price,
        price_scale: price_config.price_scale,
        price_timestamp: current_time,
        expires_at: report.expires_at as u64,
        slot: Clock::get()?.slot,
    });

    Ok(())
}

/// Get current exchange rate from stored Chainlink price.
/// Returns assets per share scaled by 1e9: price * 1_000_000_000 / price_scale
/// Example: if 1 PRIME = 1.5 wYLDS, returns 1_500_000_000
pub fn exchange_rate(ctx: Context<ConversionView>) -> Result<u64> {
    let price_config = &ctx.accounts.stake_price_config;
    require!(price_config.price > 0, CustomErrorCode::PriceNotInitialized);

    const SCALE: u128 = 1_000_000_000;
    let rate = (price_config.price as u128)
        .checked_mul(SCALE)
        .ok_or(CustomErrorCode::Overflow)?
        .checked_div(price_config.price_scale as u128)
        .ok_or(CustomErrorCode::DivisionByZero)? as u64;

    msg!("exchange_rate: {} (scaled by 1e9)", rate);

    anchor_lang::solana_program::program::set_return_data(&rate.to_le_bytes());

    Ok(rate)
}
