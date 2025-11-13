use crate::account_structs::*;
use crate::error::*;
use crate::events::*;
use crate::guard::validate_program_update_authority;
use crate::state::{calculate_assets_to_shares, calculate_exchange_rate, calculate_shares_to_assets,
                   MAX_ADMINISTRATORS, MAX_UNBONDING_PERIOD, MIN_UNBONDING_PERIOD, VIRTUAL_ASSETS, VIRTUAL_SHARES};
use anchor_lang::prelude::*;
use anchor_spl::token::spl_token::instruction::AuthorityType;
use anchor_spl::token::{self, Burn, MintTo, Transfer};

/*
# Virtual Accounting to Prevent Inflation Attacks

This implementation follows the ERC4626 virtual shares pattern.

This adds a "virtual" offset to both shares and assets in calculations,
making it economically infeasible for attackers to manipulate the exchange rate.
Doing so would require them to deposit a large amount of tokens upfront,
which would be cost-prohibitive.

There are two constants defined for virtual accounting:
- VIRTUAL_SHARES: A large number of shares added to the total supply (PRIME)
- VIRTUAL_ASSETS: A small number of assets added to the vault balance (wYLDS)

These are used in both deposit and redeem calculations to ensure fair share pricing.

The implication to the mint token economics is minimal, as the virtual offsets are small
relative to typical vault sizes and mint supplies.

What this does affect is the look of the mint token's supply and the vault's balance. When
viewing the mint token's supply, it will appear inflated
due to the virtual offsets. However, this inflation is purely notional and does not impact
the actual value or usability of the tokens. External systems and users should be aware of this when interpreting
the token metrics. Especially the mint token supply, which will be a multiple of VIRTUAL_SHARES higher than expected.

## How It Prevents Inflation Attacks:
Without Virtual Accounting (Vulnerable):

Attacker deposits 1 token (wYLDS) → gets 1 share (PRIME)
Attacker transfers 10,000 tokens directly to vault (wYLDS)
Exchange rate: 10,001 tokens / 1 share
Victim deposits 10,000 tokens → gets 0 shares (due to rounding)
Attacker withdraws, stealing victim's deposit

With Virtual Accounting (Protected):

Attacker deposits 1 token → gets 1,000,000 shares (due to virtual multiplier)
Attacker transfers 10,000 tokens directly to vault
Exchange rate: (10,001 + 1) / (1,000,000 + 1,000,000) ≈ 0.005 tokens per share
Victim deposits 10,000 tokens → gets ~2,000,000 shares (fair value)
Attack fails because the virtual offset prevents rate manipulation

## Additional Protections:

Checked Math: All arithmetic uses checked_* operations to prevent overflow
Zero Amount Checks: Prevents meaningless transactions
Proper PDA Authority: Vault is controlled by PDA, not externally
 */

pub fn initialize(
    ctx: Context<Initialize>,
    unbonding_period: i64,
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
        unbonding_period >= MIN_UNBONDING_PERIOD,
        CustomErrorCode::InvalidBondingPeriod
    );
    require!(
        unbonding_period <= MAX_UNBONDING_PERIOD,
        CustomErrorCode::InvalidBondingPeriod
    );
    require!(
        ctx.accounts.vault_token_mint.key() != ctx.accounts.mint.key(),
        CustomErrorCode::VaultAndMintCannotBeSame
    );

    let config = &mut ctx.accounts.stake_config;
    config.vault = ctx.accounts.vault_token_mint.key();
    config.mint = ctx.accounts.mint.key();
    config.unbonding_period = unbonding_period;
    config.freeze_administrators = freeze_administrators;
    config.rewards_administrators = rewards_administrators;
    config.bump = ctx.bumps.stake_config;
    config.paused = false;

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
    validate_program_update_authority(&ctx.accounts.program_data, &ctx.accounts.signer)?;
    let config = &mut ctx.accounts.stake_config;
    config.paused = pause;

    msg!("Protocol paused: {}", pause);

    Ok(())
}

pub fn update_config(ctx: Context<UpdateConfig>, new_unbonding_period: i64) -> Result<()> {
    validate_program_update_authority(&ctx.accounts.program_data, &ctx.accounts.signer)?;
    require!(
        new_unbonding_period >= MIN_UNBONDING_PERIOD,
        CustomErrorCode::InvalidBondingPeriod
    );
    require!(
        new_unbonding_period <= MAX_UNBONDING_PERIOD,
        CustomErrorCode::InvalidBondingPeriod
    );

    let config = &mut ctx.accounts.stake_config;
    config.unbonding_period = new_unbonding_period;

    emit!(UnbondingPeriodUpdated {
        admin: ctx.accounts.signer.key(),
        old_period: ctx.accounts.stake_config.unbonding_period,
        new_period: new_unbonding_period,
        mint: ctx.accounts.stake_config.mint,
        vault: ctx.accounts.stake_config.vault,
    });

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

    // Calculate shares using virtual shares and virtual assets
    // This prevents the first depositor from manipulating the share price
    // Formula: shares = (amount * (supply + VIRTUAL_SHARES)) / (vault_balance + VIRTUAL_ASSETS)
    // This single formula works for ALL deposits, including the first one
    // VIRTUAL_SHARES determines the minimum cost to execute an attack
    let numerator = (amount as u128)
        .checked_mul(
            (total_shares as u128)
                .checked_add(VIRTUAL_SHARES)
                .ok_or(CustomErrorCode::Overflow)?,
        )
        .ok_or(CustomErrorCode::Overflow)?;
    msg!("Numerator calculated: {}", numerator);

    let denominator = (total_assets as u128)
        .checked_add(VIRTUAL_ASSETS)
        .ok_or(CustomErrorCode::Overflow)?;
    msg!("Denominator calculated: {}", denominator);

    let shares_to_mint = numerator
        .checked_div(denominator as u128)
        .ok_or(CustomErrorCode::DivisionByZero)?;
    msg!("Shares to mint calculated: {}", shares_to_mint);

    // Require that user receives at least some shares
    require!(shares_to_mint > 0, CustomErrorCode::DepositTooSmall);

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
        shares_to_mint.try_into().unwrap(),
    )?;

    let result_total_assets = total_assets
        .checked_add(amount)
        .ok_or(CustomErrorCode::Overflow)?;
    let result_total_shares = total_shares
        .checked_add(shares_to_mint as u64)
        .ok_or(CustomErrorCode::Overflow)?;
    let totals_last_update_slot = Clock::get()?.slot;

    msg!("Emitting DepositEvent");
    emit!(DepositEvent {
        user: ctx.accounts.signer.key(),
        deposit_amount: amount,
        minted_amount: (shares_to_mint as u64),
        mint: ctx.accounts.mint.key(),
        mint_supply: ctx.accounts.mint.supply,
        vault: ctx.accounts.vault_token_account.key(),
        vault_balance: ctx.accounts.vault_token_account.amount,
        total_assets: result_total_assets,
        total_shares: result_total_shares,
        totals_last_update_slot: totals_last_update_slot,
    });
    msg!("Emitted DepositEvent");

    Ok(())
}

// Create an unbonding ticket for the user. They are unbonding 'amount' of mint tokens.
pub fn unbond(ctx: Context<Unbond>, amount: u64) -> Result<()> {
    msg!("Starting unbond process");
    require!(amount > 0, CustomErrorCode::InvalidAmount);
    require!(
        !ctx.accounts.stake_config.paused,
        CustomErrorCode::ProtocolPaused
    );

    let current_mint_amount = ctx.accounts.user_mint_token_account.amount;
    require!(
        amount <= current_mint_amount,
        CustomErrorCode::InsufficientUnbondingBalance
    );

    let ticket = &mut ctx.accounts.ticket;
    ticket.owner = ctx.accounts.signer.key();
    ticket.requested_amount = amount;
    ticket.start_balance = current_mint_amount;
    ticket.start_ts = Clock::get()?.unix_timestamp;

    msg!("Emitting UnbondEvent");
    emit!(UnbondEvent {
        user: ctx.accounts.signer.key(),
        amount,
        mint: ctx.accounts.mint.key(),
        vault: ctx.accounts.stake_config.vault,
    });
    msg!("Emitted UnbondingEvent");

    Ok(())
}

// Redeem the user's unbonded tokens after the unbonding period has elapsed.
// The user is allowed to redeem up to the amount they requested to unbond,
// capped by their current mint token balance. They are entitled to their
// share of the vault tokens based on the current exchange rate.
// Burn the user's mint tokens and transfer the corresponding vault tokens
// from the vault to the user.
//
pub fn redeem(ctx: Context<Redeem>) -> Result<()> {
    msg!("Starting redeem process");
    require!(
        !ctx.accounts.stake_config.paused,
        CustomErrorCode::ProtocolPaused
    );

    let now = Clock::get()?.unix_timestamp;
    let ticket = &ctx.accounts.ticket;

    require_keys_eq!(
        ticket.owner,
        ctx.accounts.signer.key(),
        CustomErrorCode::InvalidTicketOwner
    );

    let stake_config = &ctx.accounts.stake_config;
    let total_assets = ctx.accounts.vault_token_account.amount;
    let total_shares = ctx.accounts.mint.supply;
    msg!("total_assets: {}", total_assets);
    msg!("total_shares: {}", total_shares);

    require!(
        now - ticket.start_ts >= stake_config.unbonding_period,
        CustomErrorCode::UnbondingPeriodNotElapsed
    );

    let user_share_mint_balance = ctx.accounts.user_mint_token_account.amount;
    let requested_shares_to_withdraw = ticket.requested_amount.min(user_share_mint_balance);
    require!(
        requested_shares_to_withdraw > 0,
        CustomErrorCode::InsufficientUnbondingBalance
    );

    // Calculate redemption amount using virtual offsets
    // Formula: assets = (shares * (vault_balance + VIRTUAL_ASSETS)) / (supply + VIRTUAL_SHARES)
    // VIRTUAL_SHARES determines the minimum cost to execute an attack
    let numerator = (requested_shares_to_withdraw as u128)
        .checked_mul(
            (total_assets as u128)
                .checked_add(VIRTUAL_ASSETS)
                .ok_or(CustomErrorCode::Overflow)?,
        )
        .ok_or(CustomErrorCode::Overflow)?;

    msg!("Numerator calculated: {}", numerator);

    let denominator = (total_shares as u128)
        .checked_add(VIRTUAL_SHARES)
        .ok_or(CustomErrorCode::Overflow)?;

    msg!("Denominator calculated: {}", denominator);

    let amount_to_withdraw = numerator
        .checked_div(denominator)
        .ok_or(CustomErrorCode::DivisionByZero)?;

    msg!("Amount to withdraw calculated: {}", amount_to_withdraw);

    require!(
        ctx.accounts.vault_token_account.amount >= amount_to_withdraw as u64,
        CustomErrorCode::InsufficientVaultBalance
    );

    let burn_accounts = Burn {
        mint: ctx.accounts.mint.to_account_info(),
        from: ctx.accounts.user_mint_token_account.to_account_info(),
        authority: ctx.accounts.signer.to_account_info(),
    };
    token::burn(
        CpiContext::new(ctx.accounts.token_program.to_account_info(), burn_accounts),
        requested_shares_to_withdraw,
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
        amount_to_withdraw.try_into().unwrap(),
    )?;

    let result_total_assets = total_assets
        .checked_sub(amount_to_withdraw as u64)
        .ok_or(CustomErrorCode::Overflow)?;
    let result_total_shares = total_shares
        .checked_sub(requested_shares_to_withdraw)
        .ok_or(CustomErrorCode::Overflow)?;
    let totals_last_update_slot = Clock::get()?.slot;

    msg!("Emitting RedeemEvent");
    emit!(RedeemEvent {
        user: ctx.accounts.signer.key(),
        mint: ctx.accounts.mint.key(),
        requested_mint_amount: requested_shares_to_withdraw,
        mint_supply: ctx.accounts.mint.supply,
        vault: ctx.accounts.vault_token_account.key(),
        redeemed_vault_amount: amount_to_withdraw as u64,
        vault_balance: ctx.accounts.vault_token_account.amount,
        shares_burned: requested_shares_to_withdraw,
        total_assets: result_total_assets,
        total_shares: result_total_shares,
        totals_last_update_slot: totals_last_update_slot,
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

    // at this point, use CPI to call the mint_to instruction on the hastra-vault-mint
    let cpi_program = ctx.accounts.mint_program.to_account_info();
    let cpi_accounts = vault_mint::cpi::accounts::ExternalProgramMint {
        config: ctx.accounts.mint_config.to_account_info(),
        external_mint_authority: ctx.accounts.external_mint_authority.to_account_info(),
        mint: ctx.accounts.rewards_mint.to_account_info(),
        mint_authority: ctx.accounts.rewards_mint_authority.to_account_info(),
        admin: ctx.accounts.admin.to_account_info(),
        destination: ctx.accounts.vault_token_account.to_account_info(),
        token_program: ctx.accounts.token_program.to_account_info(),
    };
    // Use new_with_signer to sign with the PDA
    let cpi_ctx = CpiContext::new_with_signer(
        cpi_program,
        cpi_accounts,
        signer, // Sign with vault-stake's PDA
    );
    vault_mint::cpi::external_program_mint(cpi_ctx, amount)?;

    let totals_last_update_slot = Clock::get()?.slot;

    msg!("Publishing rewards for id: {} for amount: {}", id, amount);
    msg!("Emitting RewardsPublished");
    emit!(RewardsPublished {
        admin: ctx.accounts.admin.key(),
        amount: amount,
        mint_program: ctx.accounts.mint_program.key(),
        vault_token_account: ctx.accounts.vault_token_account.key(),
        mint: stake_config.mint,
        vault: stake_config.vault,
        total_assets: ctx.accounts.vault_token_account.amount,
        total_shares: ctx.accounts.mint.supply,
        totals_last_update_slot: totals_last_update_slot,
        id: id,
    });
    msg!("Emitted RewardsPublished");

    Ok(())
}

/// Convert shares to underlying assets
/// Returns value via return_data for efficient CPI access
pub fn shares_to_assets(ctx: Context<ConversionView>, shares: u64) -> Result<u64> {
    let total_assets = ctx.accounts.vault_token_account.amount;
    let total_shares = ctx.accounts.mint.supply;

    let assets = calculate_shares_to_assets(shares, total_shares, total_assets)?;

    msg!("shares_to_assets: {} shares = {} assets", shares, assets);

    // Set return data so other programs can read via CPI
    anchor_lang::solana_program::program::set_return_data(&assets.to_le_bytes());

    Ok(assets)
}

/// Convert underlying assets to shares
/// Returns value via return_data for efficient CPI access
pub fn assets_to_shares(ctx: Context<ConversionView>, assets: u64) -> Result<u64> {
    let total_assets = ctx.accounts.vault_token_account.amount;
    let total_shares = ctx.accounts.mint.supply;

    let shares = calculate_assets_to_shares(assets, total_shares, total_assets)?;

    msg!("assets_to_shares: {} assets = {} shares", assets, shares);

    // Set return data so other programs can read via CPI
    anchor_lang::solana_program::program::set_return_data(&shares.to_le_bytes());

    Ok(shares)
}

/// Get current exchange rate
/// Returns rate scaled by 1e9 (1_000_000_000) for precision
/// Example: if 1 share = 1.5 assets, returns 1_500_000_000
pub fn exchange_rate(ctx: Context<ConversionView>) -> Result<u64> {
    let total_assets = ctx.accounts.vault_token_account.amount;
    let total_shares = ctx.accounts.mint.supply;

    let rate = calculate_exchange_rate(total_shares, total_assets)?;

    msg!("exchange_rate: {} (scaled by 1e9)", rate);
    msg!("actual rate: {:.9}", rate as f64 / 1_000_000_000.0);

    // Set return data so other programs can read via CPI
    anchor_lang::solana_program::program::set_return_data(&rate.to_le_bytes());

    Ok(rate)
}
