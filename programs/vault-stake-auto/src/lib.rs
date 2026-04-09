pub mod account_structs;
/// # hastra sol vault stake — AUTO pool
///
/// Identical in logic to vault-stake (PRIME pool) but deployed as a separate program
/// so it has its own program id, its own `stake_config` PDA, and its own stake token
/// (AUTO instead of PRIME). Users stake the same vault token (wYLDS) to earn AUTO
/// shares; rewards are distributed by depositing additional wYLDS into the vault via
/// a CPI to vault-mint::external_program_mint, just as the PRIME pool does.
///
/// ## Business Process Flow
///
/// 1. Initial Setup:
///    - Admin creates two token types: Vault (wYLDS), Stake (AUTO)
///    - Admin initializes program with token addresses
///    - Admin configures vault token account to hold deposited wYLDS
///    - Admin registers this program in vault-mint via register_allowed_external_mint_program
///
/// 2. User Staking Flow:
///    a. Deposit Phase:
///       - User deposits vault tokens (wYLDS)
///       - System securely stores tokens in vault account
///       - User receives stake tokens (AUTO) based on their wYLDS pool share
///
/// 3. Withdrawal Flow:
///    - User calls redeem(amount) with the amount of AUTO to burn
///    - Program computes wYLDS owed using virtual shares formula
///    - AUTO is burned; wYLDS is transferred to user immediately
///
/// 4. Administrative Functions:
///    - Pause/unpause protocol operations
///    - Update freeze and rewards administrators
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

declare_id!("Dz8K7J1UrCPv8ywqxe1FKkuHa8Vm8MQtP68ohf7wPjHB");

#[program]
pub mod vault_stake_auto {
    use super::*;

    /// Initializes the vault program with the required token configurations:
    /// - vault_mint: The token that users deposit (e.g., wYLDS)
    /// - stake_mint: The token users receive when staking (e.g., AUTO)
    pub fn initialize(
        ctx: Context<Initialize>,
        freeze_administrators: Vec<Pubkey>,
        rewards_administrators: Vec<Pubkey>,
    ) -> Result<()> {
        processor::initialize(ctx, freeze_administrators, rewards_administrators)
    }

    /// Pauses or unpauses the protocol operations:
    /// - pause: true to pause, false to unpause
    pub fn pause(ctx: Context<Pause>, pause: bool) -> Result<()> {
        processor::pause(ctx, pause)
    }

    /// Handles user deposits of vault tokens (e.g., wYLDS):
    /// - Transfers vault tokens to program vault account
    /// - Mints equivalent amount of stake tokens (e.g., AUTO) to user
    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        processor::deposit(ctx, amount)
    }

    /// Redeems stake tokens (AUTO) for vault tokens (wYLDS):
    /// - Burns the specified amount of AUTO from the user's account
    /// - Transfers the proportional wYLDS from the vault to the user immediately
    /// - Optionally closes a legacy unbonding ticket (from v1) and returns rent to user
    pub fn redeem(ctx: Context<Redeem>, amount: u64) -> Result<()> {
        processor::redeem(ctx, amount)
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

    pub fn publish_rewards(ctx: Context<PublishRewards>, id: u32, amount: u64) -> Result<()> {
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

    // ========== PRICE CONFIG INSTRUCTIONS ==========

    /// Creates the StakePriceConfig PDA with Chainlink program references and staleness parameters.
    /// Must be called once after deployment before deposit or redeem can proceed.
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
        processor::initialize_price_config(
            ctx,
            chainlink_program,
            chainlink_verifier_account,
            chainlink_access_controller,
            feed_id,
            price_scale,
            price_max_staleness,
        )
    }

    /// Updates Chainlink program references and staleness parameters on an existing StakePriceConfig.
    /// Does not reset the stored price or price_timestamp.
    /// Only callable by the program upgrade authority.
    pub fn update_price_config(
        ctx: Context<UpdatePriceConfig>,
        chainlink_program: Pubkey,
        chainlink_verifier_account: Pubkey,
        chainlink_access_controller: Pubkey,
        feed_id: [u8; 32],
        price_scale: u64,
        price_max_staleness: i64,
    ) -> Result<()> {
        processor::update_price_config(
            ctx,
            chainlink_program,
            chainlink_verifier_account,
            chainlink_access_controller,
            feed_id,
            price_scale,
            price_max_staleness,
        )
    }

    /// Submits a signed Chainlink Data Streams report for on-chain verification.
    /// On success, stores the verified price in StakePriceConfig for use by deposit and redeem.
    /// Only callable by rewards administrators.
    pub fn verify_price(ctx: Context<VerifyPrice>, signed_report: Vec<u8>) -> Result<()> {
        processor::verify_price(ctx, signed_report)
    }

    /// FOR TESTING ONLY — directly sets price and price_timestamp on StakePriceConfig.
    /// Requires program upgrade authority. Use on localnet only; use verify_price in production.
    #[cfg(feature = "testing")]
    pub fn set_price_for_testing(
        ctx: Context<SetPriceForTesting>,
        price: i128,
        price_timestamp: i64,
    ) -> Result<()> {
        processor::set_price_for_testing(ctx, price, price_timestamp)
    }

    /// Updates the StakeRewardConfig PDA for the given StakeConfig. This is required after program upgrade as the config schema has changed.
    /// max_reward_bps: expressed in basis points (10_000 = 100%). Default at initialization: 75 BPS (0.75%).
    /// max_period_rewards: absolute per-call cap (raw token units, e.g. 6 decimals)
    /// reward_period_seconds: cooldown between successful publish_rewards calls
    /// max_total_rewards: lifetime cumulative cap
    /// Only callable by the program upgrade authority.
    pub fn update_reward_config(
        ctx: Context<UpdateRewardConfig>,
        max_reward_bps: u64,
        max_period_rewards: u64,
        reward_period_seconds: i64,
        max_total_rewards: u64,
    ) -> Result<()> {
        processor::update_reward_config(
            ctx,
            max_reward_bps,
            max_period_rewards,
            reward_period_seconds,
            max_total_rewards,
        )
    }

    /// Updates the maximum reward distribution cap on an existing StakeRewardConfig.
    /// Only callable by the program upgrade authority.
    pub fn update_max_reward_bps(ctx: Context<UpdateMaxRewardBps>, new_bps: u64) -> Result<()> {
        processor::update_max_reward_bps(ctx, new_bps)
    }

    /// Updates the absolute per-call rewards cap.
    /// Only callable by the program upgrade authority.
    pub fn update_max_period_rewards(
        ctx: Context<UpdateMaxPeriodRewards>,
        new_cap: u64,
    ) -> Result<()> {
        processor::update_max_period_rewards(ctx, new_cap)
    }

    /// Updates the cooldown period in seconds between successful reward publications.
    /// Only callable by the program upgrade authority.
    pub fn update_reward_period_seconds(
        ctx: Context<UpdateRewardPeriodSeconds>,
        new_seconds: i64,
    ) -> Result<()> {
        processor::update_reward_period_seconds(ctx, new_seconds)
    }

    /// Updates the lifetime cumulative rewards cap.
    /// Only callable by the program upgrade authority.
    pub fn update_max_total_rewards(
        ctx: Context<UpdateMaxTotalRewards>,
        new_cap: u64,
    ) -> Result<()> {
        processor::update_max_total_rewards(ctx, new_cap)
    }
}
