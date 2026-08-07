pub mod account_structs;
/// # Sol Vault Mint - Token Deposit and Minting Program with Rewards
///
/// ## Business Process Flow
///
/// 1. Initial Setup:
///    - Admin creates two token types: Vault (USDC), Mint (wYLDS)
///    - Admin initializes program with token addresses
///    - Admin configures vault token account to hold deposited tokens
///
/// 2. User Deposit Flow:
///    a. Deposit Phase:
///       - User deposits vault tokens (USDC)
///       - System securely stores tokens in vault account
///       - User receives equivalent mint tokens (wYLDS)
///
/// 3. Withdrawal Flow:
///    a. Redemption:
///       - Original vault tokens (USDC) returned to user, burning mint tokens (wYLDS)
///
/// 4. Administrative Functions:
///    - Update token configurations if needed
///    - Manage mint authorities
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
use state::ProofNode;

#[cfg(not(feature = "no-entrypoint"))]
use solana_security_txt::security_txt;

// Embeds stable security-reporting metadata in the deployed program binary.
#[cfg(not(feature = "no-entrypoint"))]
security_txt! {
    name: "Hastra Vault Mint",
    project_url: "https://hastra.io",
    contacts: "email:security@provenance.io",
    policy: "https://vdp.figure.com/",
    preferred_languages: "en",
    source_code: "https://github.com/provenance-io/hastra-sol-vault"
}

declare_id!("9WUyNREiPDMgwMh5Gt81Fd3JpiCKxpjZ5Dpq9Bo1RhMV");

#[program]
pub mod vault_mint {
    use super::*;

    /// Initializes the vault program with the required token configurations:
    /// - vault_mint: The token that users deposit (e.g., USDC)
    /// - mint: The token users receive when deposit received (e.g., wYLDS)
    /// - freeze_administrators: List of pubkeys authorized to freeze/thaw token accounts
    /// - rewards_administrators: List of pubkeys authorized to create rewards epochs
    /// - allowed_external_mint_program: An external program authorized to mint tokens
    pub fn initialize(
        ctx: Context<Initialize>,
        freeze_administrators: Vec<Pubkey>,
        rewards_administrators: Vec<Pubkey>,
    ) -> Result<()> {
        processor::initialize(ctx, freeze_administrators, rewards_administrators)
    }

    /// Pauses or unpauses the program, disabling or enabling deposit and redeem functions.
    pub fn pause(ctx: Context<Pause>, pause: bool) -> Result<()> {
        processor::pause(ctx, pause)
    }

    /// Handles user deposits of vault tokens (e.g., USDC):
    /// - Transfers vault tokens to program vault account
    /// - Mints equivalent amount of mint tokens (e.g., wYLDS) to user
    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        processor::deposit(ctx, amount)
    }

    /// The redeem function allows users to withdraw their original vault tokens:
    /// - Transfers vault tokens from a program vault account to user
    /// - Burns the corresponding amount of mint tokens (e.g., wYLDS) from user
    pub fn request_redeem(ctx: Context<RequestRedeem>, amount: u64) -> Result<()> {
        processor::request_redeem(ctx, amount)
    }

    /// Settles a pending redemption request, burning the user's mint tokens and paying out the
    /// corresponding vault tokens. Only callable by a rewards administrator.
    ///
    /// `expected_amount` must equal the amount recorded on the request, failing with
    /// `RedemptionAmountMismatch` otherwise. The request PDA is keyed on the user alone, so a user
    /// can cancel a reviewed request and open a replacement for a different amount at the same
    /// address; restating the approved amount keeps an already-signed completion bound to the
    /// request that was reviewed.
    pub fn complete_redeem(ctx: Context<CompleteRedeem>, expected_amount: u64) -> Result<()> {
        processor::complete_redeem(ctx, expected_amount)
    }

    /// Lets a user withdraw their own pending redemption request:
    /// - Clears the burn delegate granted by `request_redeem`, if still set to that authority
    /// - Closes the request account, refunding its rent to the user
    ///
    /// Needed because `complete_redeem` requires the full requested amount to still be held, so a
    /// user who moved their mint tokens after requesting can clear the stale request and submit a
    /// new one.
    pub fn cancel_redeem(ctx: Context<CancelRedeem>) -> Result<()> {
        processor::cancel_redeem(ctx)
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

    pub fn create_rewards_epoch(
        ctx: Context<CreateRewardsEpoch>,
        index: u64,
        merkle_root: [u8; 32],
        total: u64,
    ) -> Result<()> {
        processor::create_rewards_epoch(ctx, index, merkle_root, total)
    }

    /// This is the classic “airdrop/claim per epoch” design
    /// High-level idea:
    /// 	1.	Off-chain (admin does this each epoch):
    /// 	•	Calculate each user’s reward for this epoch.
    /// 	•	Build a Merkle tree of (user, amount, epoch_index).
    /// 	•	Publish the Merkle root on-chain with the create_rewards_epoch function above.
    ///
    /// 	2.	On-chain:
    /// 	•	Store each epoch’s Merkle root in a PDA.
    /// 	•	When a user claims, they present (amount, proof) for their pubkey.
    /// 	•	The program verifies the Merkle proof against the root.
    /// 	•	If valid, mint reward tokens (wYLDS) to the user's mint token account.
    /// 	•	Mark the claim as redeemed so they can’t double-claim.
    ///     •   Epochs with `index >= first_capped_epoch` also enforce the aggregate claim cap.
    pub fn claim_rewards(
        ctx: Context<ClaimRewards>,
        amount: u64,
        proof: Vec<ProofNode>,
    ) -> Result<()> {
        processor::claim_rewards(ctx, amount, proof)
    }

    /// One-shot: enables epoch caps (upgrade authority).
    /// Must be executed after program upgrade before create/claim rewards.
    /// Sets `first_capped_epoch` and `max_epoch_cap`. Epochs already created below that
    /// index stay uncapped; new epochs cannot be created there. Contiguous create indices
    /// are enforced separately by `LastRewardsEpoch` (see `initialize_last_rewards_epoch`).
    pub fn initialize_epoch_caps(
        ctx: Context<InitializeEpochCaps>,
        first_capped_epoch: u64,
        max_epoch_cap: u64,
    ) -> Result<()> {
        processor::initialize_epoch_caps(ctx, first_capped_epoch, max_epoch_cap)
    }

    /// Creates the LastRewardsEpoch PDA, seeding the index floor for create_rewards_epoch.
    /// Must be called once before create can succeed. Only callable by the program upgrade
    /// authority. Requires epoch caps already initialized; rejects a floor that would deadlock
    /// create (`start_index + 1 < first_capped_epoch`). Subsequent creates must use exact
    /// succession (`start_index + 1`, then contiguous).
    pub fn initialize_last_rewards_epoch(
        ctx: Context<InitializeLastRewardsEpoch>,
        start_index: u64,
    ) -> Result<()> {
        processor::initialize_last_rewards_epoch(ctx, start_index)
    }

    /// Corrects the LastRewardsEpoch floor (upgrade authority). Recovery when start_index was
    /// seeded wrongly; enforces the same first_capped_epoch check as init.
    pub fn update_last_rewards_epoch(
        ctx: Context<UpdateLastRewardsEpoch>,
        new_index: u64,
    ) -> Result<()> {
        processor::update_last_rewards_epoch(ctx, new_index)
    }

    /// Updates the global max epoch cap (upgrade authority). Affects future creates only.
    pub fn update_max_epoch_cap(ctx: Context<UpdateMaxEpochCap>, new_cap: u64) -> Result<()> {
        processor::update_max_epoch_cap(ctx, new_cap)
    }

    /// Allows an external authorized program to mint tokens to a specified account.
    /// The calling_program account identifies the CPI caller; it must match either
    /// config.allowed_external_mint_program (legacy) or be listed in the
    /// allowed_external_mint_programs PDA (registered via register_allowed_external_mint_program).
    pub fn external_program_mint(ctx: Context<ExternalProgramMint>, amount: u64) -> Result<()> {
        processor::external_program_mint(ctx, amount)
    }

    /// Registers an additional external program as authorized to call external_program_mint.
    /// Creates the AllowedExternalMintPrograms PDA on first call (init_if_needed).
    /// Idempotent: calling with an already-registered program is a no-op.
    /// The active cap is controlled via update_external_mint_programs_limit.
    /// Only callable by the program upgrade authority.
    pub fn register_allowed_external_mint_program(
        ctx: Context<RegisterAllowedExternalMintProgram>,
    ) -> Result<()> {
        processor::register_allowed_external_mint_program(ctx)
    }

    /// Updates the cap enforced by register_allowed_external_mint_program.
    /// Only callable by the program upgrade authority.
    pub fn update_external_mint_programs_limit(
        ctx: Context<UpdateExternalMintProgramsLimit>,
        max_programs: u8,
    ) -> Result<()> {
        processor::update_external_mint_programs_limit(ctx, max_programs)
    }

    pub fn update_vault_token_account(ctx: Context<UpdateVaultTokenAccount>) -> Result<()> {
        processor::update_vault_token_account(ctx)
    }

    /// Sets `config.redeem_vault` to a PDA-owned vault-mint token account.
    /// Call once after upgrade on deployments initialized before this field was written.
    pub fn update_redeem_vault(ctx: Context<UpdateRedeemVault>) -> Result<()> {
        processor::update_redeem_vault(ctx)
    }

    pub fn sweep_redeem_vault_funds(
        ctx: Context<SweepRedeemVaultFunds>,
        amount: u64,
    ) -> Result<()> {
        processor::sweep_redeem_vault_funds(ctx, amount)
    }
}
