pub mod account_structs;
/// # hastra sol vault stake - Token Staking System
///
/// ## Business Process Flow
///
/// 1. Initial Setup:
///    - Admin creates two token types: Vault (wYLDS), Stake (PRIME)
///    - Admin initializes program with token addresses and unbonding period
///    - Admin configures vault token account to hold deposited tokens
///
/// 2. User Staking Flow:
///    a. Deposit Phase:
///       - User deposits vault tokens (wYLDS)
///       - System securely stores tokens in vault account
///       - User receives stake tokens (PRIME) based on their wYLDS pool share
///
/// 3. Withdrawal Flow:
///    a. Unbonding Initiation:
///       - User initiates withdrawal by burning stake tokens (PRIME)
///       - System creates an unbonding ticket attached to the user
///       - Unbonding period timer starts
///    
///    b. Waiting Period:
///       - User holds an unbonding ticket during lock period
///       - Can query remaining time via status check
///    
///    c. Redemption:
///       - After the unbonding period expires, the user can redeem
///       - Vault tokens (wYLDS) returned to user based on their minted PRIME share
///       - Unbonding ticket is invalidated
///
/// 4. Administrative Functions:
///    - Update token configurations if needed
///    - Monitor vault token accounts
///
/// Security is maintained through PDAs (Program Derived Addresses) and strict
/// token authority controls. All token operations are atomic and validated
/// through Solana's transaction model.
pub mod error;
pub mod events;
mod guard;
pub mod processor;
pub mod state;

use account_structs::*;
use anchor_lang::prelude::*;

declare_id!("97V7JsExNC6yFWu5KjK1FLfVkNVvtMpAFL5QkLWKEGxY");

#[program]
pub mod vault_stake {
    use super::*;

    /// Initializes the vault program with the required token configurations:
    /// - vault_mint: The token that users deposit (e.g., wYLDS)
    /// - stake_mint: The token users receive when staking (e.g., PRIME)
    /// - unbonding_period: Time in seconds users must wait before redeeming
    pub fn initialize(
        ctx: Context<Initialize>,
        unbonding_period: i64,
        freeze_administrators: Vec<Pubkey>,
        rewards_administrators: Vec<Pubkey>,
    ) -> Result<()> {
        processor::initialize(
            ctx,
            unbonding_period,
            freeze_administrators,
            rewards_administrators,
        )
    }

    /// Pauses or unpauses the protocol operations:
    /// - pause: true to pause, false to unpause
    pub fn pause(ctx: Context<Pause>, pause: bool) -> Result<()> {
        processor::pause(ctx, pause)
    }
    
    /// Updates the program configuration with new token addresses:
    /// - new_unbonding_period: New unbonding period in seconds
    pub fn update_config(ctx: Context<UpdateConfig>, new_unbonding_period: i64) -> Result<()> {
        processor::update_config(ctx, new_unbonding_period)
    }

    /// Handles user deposits of vault tokens (e.g., wYLDS):
    /// - Transfers vault tokens to program vault account
    /// - Mints equivalent amount of stake tokens (e.g., PRIME) to user
    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        processor::deposit(ctx, amount)
    }

    /// Initiates the unbonding process:
    /// - Burns user's stake tokens (e.g., PRIME)
    /// - Starts unbonding period timer via user ticket
    pub fn unbond(ctx: Context<Unbond>, amount: u64) -> Result<()> {
        processor::unbond(ctx, amount)
    }

    /// Completes the unbonding process after the period expires:
    /// - Burns unbonding tokens (e.g., uwYLDS)
    /// - Returns vault tokens (e.g., wYLDS) to user
    pub fn redeem(ctx: Context<Redeem>) -> Result<()> {
        processor::redeem(ctx)
    }

    pub fn update_freeze_administrators(
        ctx: Context<UpdateFreezeAdministrators>,
        new_administrators: Vec<Pubkey>,
    ) -> Result<()> {
        processor::update_freeze_administrators(ctx, new_administrators)
    }

    pub fn freeze_token_account(ctx: Context<FreezeTokenAccount>) -> Result<()> {
        processor::freeze_token_account(ctx)
    }
    pub fn thaw_token_account(ctx: Context<ThawTokenAccount>) -> Result<()> {
        processor::thaw_token_account(ctx)
    }

    pub fn update_rewards_administrators(
        ctx: Context<UpdateRewardsAdministrators>,
        new_administrators: Vec<Pubkey>,
    ) -> Result<()> {
        processor::update_rewards_administrators(ctx, new_administrators)
    }

    pub fn publish_rewards(
        ctx: Context<PublishRewards>,
        id: u32,
        amount: u64,
    ) -> Result<()> {
        processor::publish_rewards(ctx, id, amount)
    }

    pub fn shares_to_assets(ctx: Context<ConversionView>, shares: u64) -> Result<u64> {
        processor::shares_to_assets(ctx, shares)
    }

    pub fn assets_to_shares(ctx: Context<ConversionView>, assets: u64) -> Result<u64> {
        processor::assets_to_shares(ctx, assets)
    }

    pub fn exchange_rate(ctx: Context<ConversionView>) -> Result<u64> {
        processor::exchange_rate(ctx)   
    }
}
