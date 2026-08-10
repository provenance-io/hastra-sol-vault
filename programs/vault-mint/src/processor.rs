use crate::account_structs::*;
use crate::error::*;
use crate::events::*;
use crate::guard::{validate_administrators, validate_program_update_authority};
use crate::state::{AllowedExternalMintPrograms, EpochClaimedAmount, ProofNode};
use anchor_lang::prelude::*;
use anchor_lang::solana_program::hash::hashv;
use anchor_lang::solana_program::program::invoke;
use anchor_lang::solana_program::program_option::COption;
use anchor_lang::solana_program::system_instruction;
use anchor_spl::token::spl_token::instruction::AuthorityType;
use anchor_spl::token::{self, MintTo, Transfer};

pub fn initialize(
    ctx: Context<Initialize>,
    freeze_administrators: Vec<Pubkey>,
    rewards_administrators: Vec<Pubkey>,
) -> Result<()> {
    msg!(
        "Initializing with vault_token_mint: {}",
        ctx.accounts.vault_token_mint.key()
    );
    msg!(
        "Vault mint account: {}",
        ctx.accounts.vault_token_mint.key()
    );

    validate_program_update_authority(&ctx.accounts.program_data, &ctx.accounts.signer)?;
    validate_administrators(&freeze_administrators)?;
    validate_administrators(&rewards_administrators)?;

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
    config.redeem_vault = ctx.accounts.redeem_vault_token_account.key();

    let vault_token_account_config = &mut ctx.accounts.vault_token_account_config;
    vault_token_account_config.vault_token_account = ctx.accounts.vault_token_account.key();
    vault_token_account_config.bump = ctx.bumps.vault_token_account_config;

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
    let config = &ctx.accounts.config;
    let signer = ctx.accounts.signer.key();

    // Verify signer is a freeze administrator
    require!(
        config.freeze_administrators.contains(&signer),
        CustomErrorCode::UnauthorizedFreezeAdministrator
    );

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

    // amount_to_redeem = min(user wYLDS balance, requested)
    // We do this to prevent the program from over-burning when the
    // redeem is completed. The complete redeem will also check the
    // redeem amount against the user balance at the time of completion to
    // prevent burn error.
    let amount_to_redeem = std::cmp::min(user_balance, amount);
    require!(
        amount_to_redeem > 0,
        CustomErrorCode::InsufficientRedemptionBalance
    );

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

/// Withdraws the caller's own pending redemption request.
///
/// `complete_redeem` requires the user to still hold the full requested amount, so a request whose
/// owner has since moved wYLDS out cannot be completed. Without this instruction that request would
/// stay open indefinitely and block new ones, since `request_redeem` allows only one
/// `RedemptionRequest` PDA per user. Closes the request, refunding its rent to the user, and clears
/// the burn delegate granted at request time when that delegate is still in place.
///
/// Not gated on `paused`: cancelling releases a protocol obligation and moves no protocol funds, so
/// blocking it during a pause would only trap users.
pub fn cancel_redeem(ctx: Context<CancelRedeem>) -> Result<()> {
    let amount = ctx.accounts.redemption_request.amount;

    // Only clear the allowance if it is still the one `request_redeem` granted. SPL token accounts
    // hold a single delegate, so a user who re-delegated afterwards already invalidated the burn
    // approval; cancelling must not silently revoke that unrelated grant.
    let delegate_is_redeem_authority = matches!(
        ctx.accounts.user_mint_token_account.delegate,
        COption::Some(delegate) if delegate == ctx.accounts.redeem_vault_authority.key()
    );

    if delegate_is_redeem_authority {
        token::revoke(CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            token::Revoke {
                source: ctx.accounts.user_mint_token_account.to_account_info(),
                authority: ctx.accounts.signer.to_account_info(),
            },
        ))?;
    }

    msg!("Cancelled redemption request for {} tokens", amount);

    emit!(RedemptionCancelled {
        user: ctx.accounts.signer.key(),
        amount,
        mint: ctx.accounts.config.mint,
        vault: ctx.accounts.config.vault,
    });

    // Anchor closes redemption_request to `signer` per the accounts attr
    Ok(())
}

/// Settles a pending redemption request: burns the user's mint tokens and pays out the
/// corresponding vault tokens.
///
/// `expected_amount` is the amount the administrator approved. The `RedemptionRequest` PDA is
/// derived from the user alone, so its address does not change when the recorded amount does: a
/// user can `cancel_redeem` a reviewed request and open a replacement for a different amount at the
/// same address, and an already-signed completion would otherwise settle whatever it finds there.
/// Requiring the caller to restate the approved amount binds this settlement to the request that
/// was actually reviewed. Solvency was never at risk — the full recorded amount is burned and paid
/// to the same user either way — but amount-specific operational and compliance approval was.
pub fn complete_redeem(ctx: Context<CompleteRedeem>, expected_amount: u64) -> Result<()> {
    // Admin gate
    require!(
        ctx.accounts
            .config
            .rewards_administrators
            .contains(&ctx.accounts.admin.key()),
        CustomErrorCode::InvalidRewardsAdministrator
    );

    let req = &ctx.accounts.redemption_request;
    let amount_to_redeem = req.amount;
    require!(amount_to_redeem > 0, CustomErrorCode::InvalidAmount);

    // Reject a request that was substituted after the administrator approved this amount.
    require!(
        amount_to_redeem == expected_amount,
        CustomErrorCode::RedemptionAmountMismatch
    );

    // Fail closed if the user no longer holds the full requested amount.
    // Partial completion would close the request and silently under-deliver USDC.
    let user_mint_balance = ctx.accounts.user_mint_token_account.amount;
    require!(
        user_mint_balance >= amount_to_redeem,
        CustomErrorCode::InsufficientRedemptionBalance
    );

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
    validate_administrators(&new_administrators)?;

    let config = &mut ctx.accounts.config;
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
    validate_administrators(&new_administrators)?;

    let config = &mut ctx.accounts.config;
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
    require!(!ctx.accounts.config.paused, CustomErrorCode::ProtocolPaused);
    require!(
        ctx.accounts
            .config
            .rewards_administrators
            .contains(&ctx.accounts.admin.key()),
        CustomErrorCode::InvalidRewardsAdministrator
    );
    require!(total > 0, CustomErrorCode::InvalidAmount);

    let caps = &ctx.accounts.epoch_caps_config;
    // Indices below `first_capped_epoch` are reserved for epochs that predate the caps
    // upgrade, which `claim_rewards` exempts from aggregate cap enforcement. Creating a new
    // epoch at an unused index down there would make its declared `total` unenforceable and
    // allow unbounded minting against the Merkle root, so the boundary is closed here.
    require!(
        index >= caps.first_capped_epoch,
        CustomErrorCode::EpochIndexBelowFirstCapped
    );
    // Exact succession via LastRewardsEpoch (separate from cap config so create cannot
    // mutate first_capped_epoch / max_epoch_cap). Overflow of u64 is the natural ceiling.
    let last = &mut ctx.accounts.last_rewards_epoch;
    let expected = last
        .index
        .checked_add(1)
        .ok_or(ProgramError::ArithmeticOverflow)?;
    require!(
        index == expected,
        CustomErrorCode::EpochIndexNotContiguous
    );
    require!(
        total <= caps.max_epoch_cap,
        CustomErrorCode::EpochCapAboveGlobal
    );
    last.index = index;

    let e = &mut ctx.accounts.epoch;
    e.index = index;
    e.merkle_root = merkle_root;
    e.total = total;
    e.created_ts = Clock::get()?.unix_timestamp;

    ctx.accounts.epoch_claimed.claimed_total = 0;

    emit!(RewardsEpochCreated {
        admin: ctx.accounts.admin.key(),
        index,
        merkle_root,
        total,
        created_ts: e.created_ts,
    });

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

    // Cap enforcement for epochs at or after `first_capped_epoch`.
    // Epochs below that index skip the aggregate counter; ClaimRecord still prevents double-claim.
    // Only epochs predating the caps upgrade can sit below the boundary, because
    // `create_rewards_epoch` refuses those indices.
    // `epoch_caps_config` must already be initialized (typed Account constraint).
    let epoch_index = ctx.accounts.epoch.index;
    let enforce_cap = epoch_index >= ctx.accounts.epoch_caps_config.first_capped_epoch;

    if enforce_cap {
        let claimed_info = ctx.accounts.epoch_claimed.to_account_info();
        require!(
            !claimed_info.data_is_empty(),
            CustomErrorCode::EpochClaimedRequired
        );
        let mut data = claimed_info.try_borrow_mut_data()?;
        let mut claimed = EpochClaimedAmount::try_deserialize(&mut &data[..])?;
        let new_claimed = claimed
            .claimed_total
            .checked_add(amount)
            .ok_or(CustomErrorCode::InvalidAmount)?;
        require!(
            new_claimed <= ctx.accounts.epoch.total,
            CustomErrorCode::EpochCapExceeded
        );
        // Increment claimed_total before minting so a failed mint cannot leave
        // the counter behind the actual minted supply.
        claimed.claimed_total = new_claimed;
        let mut cursor = std::io::Cursor::new(&mut data[..]);
        claimed.try_serialize(&mut cursor)?;
    }

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

/// One-shot initializer for epoch caps after program upgrade.
pub fn initialize_epoch_caps(
    ctx: Context<InitializeEpochCaps>,
    first_capped_epoch: u64,
    max_epoch_cap: u64,
) -> Result<()> {
    validate_program_update_authority(&ctx.accounts.program_data, &ctx.accounts.signer)?;
    require!(max_epoch_cap > 0, CustomErrorCode::InvalidGlobalCap);

    let caps = &mut ctx.accounts.epoch_caps_config;
    caps.max_epoch_cap = max_epoch_cap;
    caps.first_capped_epoch = first_capped_epoch;
    caps.bump = ctx.bumps.epoch_caps_config;

    emit!(FirstCappedEpochSet {
        epoch_index: first_capped_epoch,
    });
    emit!(MaxEpochCapUpdated {
        old_cap: 0,
        new_cap: max_epoch_cap,
    });

    Ok(())
}

/// Ensures the next create index (`floor + 1`) is at or above `first_capped_epoch`.
/// Without this, contiguous succession would permanently fail against the cap boundary.
fn require_next_epoch_at_or_above_first_capped(floor: u64, first_capped_epoch: u64) -> Result<()> {
    let next = floor
        .checked_add(1)
        .ok_or(ProgramError::ArithmeticOverflow)?;
    require!(
        next >= first_capped_epoch,
        CustomErrorCode::EpochIndexBelowFirstCapped
    );
    Ok(())
}

/// Initializes the LastRewardsEpoch PDA with `start_index` as the floor for future creates.
/// Must be called once before `create_rewards_epoch` can succeed. The next create must use
/// `start_index + 1`, then contiguous indices. Only callable by the program upgrade authority.
/// Rejects a floor that would deadlock create (`start_index + 1 < first_capped_epoch`).
pub fn initialize_last_rewards_epoch(
    ctx: Context<InitializeLastRewardsEpoch>,
    start_index: u64,
) -> Result<()> {
    validate_program_update_authority(&ctx.accounts.program_data, &ctx.accounts.signer)?;
    require_next_epoch_at_or_above_first_capped(
        start_index,
        ctx.accounts.epoch_caps_config.first_capped_epoch,
    )?;

    let last = &mut ctx.accounts.last_rewards_epoch;
    last.index = start_index;
    last.bump = ctx.bumps.last_rewards_epoch;

    emit!(LastRewardsEpochInitialized { start_index });

    msg!("LastRewardsEpoch initialized");
    msg!("start_index: {}", start_index);

    Ok(())
}

/// Corrects the LastRewardsEpoch floor. Recovery for a wrongly seeded start_index; enforces
/// the same first_capped_epoch check as init so create cannot be deadlocked. Upgrade
/// authority only.
pub fn update_last_rewards_epoch(
    ctx: Context<UpdateLastRewardsEpoch>,
    new_index: u64,
) -> Result<()> {
    validate_program_update_authority(&ctx.accounts.program_data, &ctx.accounts.signer)?;
    require_next_epoch_at_or_above_first_capped(
        new_index,
        ctx.accounts.epoch_caps_config.first_capped_epoch,
    )?;

    let last = &mut ctx.accounts.last_rewards_epoch;
    let old_index = last.index;
    last.index = new_index;

    emit!(LastRewardsEpochUpdated {
        old_index,
        new_index,
    });

    msg!("LastRewardsEpoch updated");
    msg!("old_index: {}", old_index);
    msg!("new_index: {}", new_index);

    Ok(())
}

/// Updates the global max epoch cap. Affects future `create_rewards_epoch` calls only.
pub fn update_max_epoch_cap(ctx: Context<UpdateMaxEpochCap>, new_cap: u64) -> Result<()> {
    validate_program_update_authority(&ctx.accounts.program_data, &ctx.accounts.signer)?;
    require!(new_cap > 0, CustomErrorCode::InvalidGlobalCap);

    let caps = &mut ctx.accounts.epoch_caps_config;
    require!(caps.max_epoch_cap > 0, CustomErrorCode::CapsNotInitialized);

    let old_cap = caps.max_epoch_cap;
    caps.max_epoch_cap = new_cap;

    emit!(MaxEpochCapUpdated { old_cap, new_cap });

    Ok(())
}

/// Allows an authorized external program to mint wYLDS tokens into a destination account.
/// Authorization uses two complementary paths for a safe, zero-downtime migration:
///
/// **Legacy path** (`config.allowed_external_mint_program`): The original single-program
/// field set at `initialize` time. The existing vault-stake (PRIME) deployment continues
/// to work without any re-initialization.
///
/// **Extended path** (`allowed_external_mint_programs` PDA): An additive PDA that holds a
/// `Vec<Pubkey>` of additional authorized programs. vault-stake-auto (and future pools) are
/// registered here via `register_allowed_external_mint_program`. Deployments must create this
/// PDA on-chain before relying on `external_program_mint` (typically as part of the upgrade
/// proposal: run `register_allowed_external_mint_program` once so `init_if_needed` allocates
/// the account). If account data is empty or fails to deserialize, the extended list is
/// treated as empty and only the legacy `allowed_external_mint_program` check applies.
///
/// Cryptographic proof of caller identity comes from the `external_mint_authority` PDA
/// signer: its address is derived with `seeds = [b"external_mint_authority"]` under
/// `calling_program`'s program id, so only `calling_program` can produce a valid signer.
pub fn external_program_mint(ctx: Context<ExternalProgramMint>, amount: u64) -> Result<()> {
    require!(!ctx.accounts.config.paused, CustomErrorCode::ProtocolPaused);

    let config = &ctx.accounts.config;

    // Verify admin is a rewards administrator. `admin` is a Signer on the outer
    // transaction (preserved across CPI); external_mint_authority remains the PDA
    // that proves the calling program's identity.
    require!(
        config
            .rewards_administrators
            .contains(&ctx.accounts.admin.key()),
        CustomErrorCode::InvalidRewardsAdministrator
    );

    // Verify calling_program is authorized. The external_mint_authority PDA seeds constraint
    // in account_structs already proves that the signer was derived from calling_program's id;
    // here we verify that program id is actually permitted.
    let calling_key = ctx.accounts.calling_program.key();

    // Legacy path: the single program id stored in Config at initialization time.
    let is_legacy_caller = calling_key == config.allowed_external_mint_program;

    // Extended path: try to deserialize the allow-list PDA. The account may be empty
    // (PDA not yet initialized) for deployments that have not registered extra programs.
    let is_registered_caller = if !is_legacy_caller {
        let data = ctx
            .accounts
            .allowed_external_mint_programs
            .try_borrow_data()?;
        if data.len() >= 8 {
            let mut slice: &[u8] = &*data;
            AllowedExternalMintPrograms::try_deserialize(&mut slice)
                .map(|allowed| allowed.programs.contains(&calling_key))
                .unwrap_or(false)
        } else {
            false
        }
    } else {
        false
    };

    require!(
        is_legacy_caller || is_registered_caller,
        CustomErrorCode::InvalidMintProgramCaller
    );

    // Mint tokens using the mint_authority PDA.
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
        amount,
        mint: ctx.accounts.mint.key(),
        vault: ctx.accounts.config.vault,
    });
    msg!("Emitted ExternalProgramMintEvent");

    Ok(())
}

// create a function called by program update authority to update the vault token account
pub fn update_vault_token_account(ctx: Context<UpdateVaultTokenAccount>) -> Result<()> {
    // Validate that the signer is the program's update authority
    validate_program_update_authority(&ctx.accounts.program_data, &ctx.accounts.signer)?;

    let config = &mut ctx.accounts.config;
    config.vault_authority = ctx.accounts.vault_token_account.owner;

    let vault_token_account_config = &mut ctx.accounts.vault_token_account_config;
    vault_token_account_config.vault_token_account = ctx.accounts.vault_token_account.key();

    msg!(
        "Vault token authority updated to: {}",
        ctx.accounts.vault_token_account.owner.key()
    );
    msg!(
        "Vault token account updated to: {}",
        ctx.accounts.vault_token_account.key()
    );
    Ok(())
}

/// Sets `config.redeem_vault` to the supplied PDA-owned token account.
/// Required once after upgrade on deployments that initialized before this field was written;
/// until then `complete_redeem` / `sweep_redeem_vault_funds` fail the key pin.
/// Only callable by the program upgrade authority.
pub fn update_redeem_vault(ctx: Context<UpdateRedeemVault>) -> Result<()> {
    validate_program_update_authority(&ctx.accounts.program_data, &ctx.accounts.signer)?;

    let config = &mut ctx.accounts.config;
    config.redeem_vault = ctx.accounts.redeem_vault_token_account.key();

    msg!(
        "Redeem vault updated to: {}",
        ctx.accounts.redeem_vault_token_account.key()
    );
    Ok(())
}

/// Registers an additional external program as authorized to call external_program_mint.
/// Idempotent: re-registering an already-listed program is a no-op.
/// Enforces the configurable cap stored in ExternalMintProgramsLimitConfig.
/// Only callable by the program upgrade authority.
pub fn register_allowed_external_mint_program(
    ctx: Context<RegisterAllowedExternalMintProgram>,
) -> Result<()> {
    validate_program_update_authority(&ctx.accounts.program_data, &ctx.accounts.signer)?;

    let program_key = ctx.accounts.external_program.key();
    let allowed = &mut ctx.accounts.allowed_external_mint_programs;
    let limit_config = &mut ctx.accounts.external_mint_programs_limit_config;

    // Idempotent: skip if the program is already in the list.
    if allowed.programs.contains(&program_key) {
        msg!("Program {} is already registered; no-op", program_key);
        return Ok(());
    }

    require!(
        allowed.programs.len() < limit_config.max_programs as usize,
        CustomErrorCode::TooManyAllowedExternalMintPrograms
    );

    let required_len =
        AllowedExternalMintPrograms::len_for_program_count(allowed.programs.len() + 1);
    let allowed_info = allowed.to_account_info();
    if allowed_info.data_len() < required_len {
        let rent = Rent::get()?;
        let required_lamports = rent.minimum_balance(required_len);
        let current_lamports = allowed_info.lamports();
        if current_lamports < required_lamports {
            let delta = required_lamports
                .checked_sub(current_lamports)
                .ok_or(ProgramError::ArithmeticOverflow)?;
            invoke(
                &system_instruction::transfer(
                    &ctx.accounts.signer.key(),
                    &allowed_info.key(),
                    delta,
                ),
                &[
                    ctx.accounts.signer.to_account_info(),
                    allowed_info.clone(),
                    ctx.accounts.system_program.to_account_info(),
                ],
            )?;
        }
        allowed_info.realloc(required_len, false)?;
    }

    allowed.programs.push(program_key);
    allowed.bump = ctx.bumps.allowed_external_mint_programs;

    msg!(
        "Registered authorized external mint program: {}",
        program_key
    );
    Ok(())
}

/// Updates the cap used when registering authorized external mint callers.
/// Only callable by the program upgrade authority.
pub fn update_external_mint_programs_limit(
    ctx: Context<UpdateExternalMintProgramsLimit>,
    max_programs: u8,
) -> Result<()> {
    validate_program_update_authority(&ctx.accounts.program_data, &ctx.accounts.signer)?;

    let limit_config = &mut ctx.accounts.external_mint_programs_limit_config;
    limit_config.max_programs = max_programs;
    limit_config.bump = ctx.bumps.external_mint_programs_limit_config;

    msg!(
        "Updated allowed external mint program limit to {}",
        max_programs
    );
    Ok(())
}

pub fn sweep_redeem_vault_funds(ctx: Context<SweepRedeemVaultFunds>, amount: u64) -> Result<()> {
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
        amount,
    )?;

    msg!("Emitting SweepRedeemVaultEvent");
    emit!(SweepRedeemVaultEvent {
        admin: ctx.accounts.signer.key(),
        destination: ctx.accounts.vault_token_account.key(),
        amount,
        vault: ctx.accounts.redeem_vault_token_account.mint,
    });
    msg!("Emitted SweepRedeemVaultEvent");

    Ok(())
}
