# Hastra SOL Integration Guide — vault-mint

Programmatic lifecycle for **vault-mint**: USDC ↔ wYLDS (1:1), operator-mediated USDC redemption, and merkle-based wYLDS reward claims.

**Program ID (mainnet / declared id):** `9WUyNREiPDMgwMh5Gt81Fd3JpiCKxpjZ5Dpq9Bo1RhMV`

Codebase: https://github.com/provenance-io/hastra-sol-vault

**Related docs**

- Stake pools (PRIME / AUTO / SMB): [`hastra-sol-vault-stake-integration-guide.md`](./hastra-sol-vault-stake-integration-guide.md)
- Live config fields: [`scripts/vault-mint/fetch_config.ts`](../scripts/vault-mint/fetch_config.ts), [`fetch_vault_token_account_config.ts`](../scripts/vault-mint/fetch_vault_token_account_config.ts), [`fetch_epoch_caps_config.ts`](../scripts/vault-mint/fetch_epoch_caps_config.ts), [`fetch_external_mint_pdas.ts`](../scripts/vault-mint/fetch_external_mint_pdas.ts)

---

## Overview

wYLDS is the base-layer wrapped token on Solana: a 1:1 receipt for USDC deposited into the configured deposit vault token account. The deposit vault’s SPL **token authority** is configured at initialize (on mainnet this is treasury custody, not a mint PDA). The program still enforces minting rules and uses PDAs for mint authority, redeem-vault authority, and admin-gated flows.

| Flow | Instruction(s) | Result |
|------|----------------|--------|
| Mint | `deposit` | User USDC → deposit vault; user receives wYLDS 1:1 |
| Exit to USDC | `request_redeem` → `complete_redeem` | User delegates wYLDS; operator burns it and pays USDC from the redeem vault |
| Abandon an exit | `cancel_redeem` | User clears their own pending request; no funds move |
| Merkle rewards | `claim_rewards` | User receives newly minted wYLDS for an epoch allocation |

---

## PDA derivations

```typescript
const vaultMintProgramId = new PublicKey("9WUyNREiPDMgwMh5Gt81Fd3JpiCKxpjZ5Dpq9Bo1RhMV");

const [configPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    vaultMintProgramId
);
const [vaultTokenAccountConfigPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault_token_account_config"), configPda.toBuffer()],
    vaultMintProgramId
);
const [mintAuthorityPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("mint_authority")],
    vaultMintProgramId
);
const [redeemVaultAuthorityPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("redeem_vault_authority")],
    vaultMintProgramId
);
```

Resolve the live deposit vault ATA from `VaultTokenAccountConfig.vault_token_account`, the redeem vault ATA from `Config.redeem_vault`, and the USDC / wYLDS mints from `Config.vault` / `Config.mint` (see `scripts/vault-mint/fetch_config.ts`).

---

## 1. Deposit: USDC → wYLDS

`deposit` transfers USDC from the user’s ATA into the configured deposit vault ATA and mints the same amount of wYLDS. The user’s source vault token account must differ from the deposit vault account (self-transfer deposits are rejected with `DepositSelfTransfer`).

```typescript
const vaultMint = new Program(idl, provider);

await vaultMint.methods
    .deposit(new BN(amount))
    .accountsStrict({
        config: configPda,
        vaultTokenAccount: vaultUsdcAta,              // configured deposit vault ATA
        vaultTokenAccountConfig: vaultTokenAccountConfigPda,
        mint: wyldsMint,
        mintAuthority: mintAuthorityPda,
        signer: userPublicKey,
        userVaultTokenAccount: userUsdcAta,
        userMintTokenAccount: userWyldsAta,
        tokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers([user])
    .rpc();
```

Next step for staking: see the [vault-stake integration guide](./hastra-sol-vault-stake-integration-guide.md).

---

## 2. Redeem: wYLDS → USDC (operator-mediated)

Two-step flow. `request_redeem` does **not** burn: it approves the `redeem_vault_authority` PDA as SPL delegate over the requested wYLDS and records a `RedemptionRequest`. The wYLDS stays in the user’s ATA until the operator funds the **redeem** vault (PDA-owned, e.g. via Circle CCTP) and calls `complete_redeem`, which burns the wYLDS through the delegate and pays the same amount of USDC. Batching minimums and banking-hours delays may apply.

**For many integrators, stopping at wYLDS is enough unless USDC settlement is required.**

### 2a. `request_redeem`

```typescript
const [redemptionRequestPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("redemption_request"), userPublicKey.toBuffer()],
    vaultMintProgramId
);

await vaultMint.methods
    .requestRedeem(new BN(wyldsAmount))
    .accountsStrict({
        signer: userPublicKey,
        userMintTokenAccount: userWyldsAta,
        redemptionRequest: redemptionRequestPda,
        mint: wyldsMint,
        config: configPda,
        redeemVaultAuthority: redeemVaultAuthorityPda,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers([user])
    .rpc();
```

The user must hold at least `wyldsAmount` (`InsufficientBalance` otherwise). Only one pending `RedemptionRequest` per user; the user pays its rent and gets it back on completion or cancellation. Emits `RedemptionRequested`.

Because the wYLDS is only delegated, the user can still move it. Doing so (or granting a different delegate, since an SPL account holds a single delegate) makes the request uncompletable until it is cancelled.

### 2b. `complete_redeem` (rewards administrator)

```typescript
await vaultMint.methods
    .completeRedeem(expectedAmount)
    .accountsStrict({
        admin: operatorPublicKey,
        user: userPublicKey,
        userMintTokenAccount: userWyldsAta,
        userVaultTokenAccount: userUsdcAta,
        redemptionRequest: redemptionRequestPda,
        redeemVaultTokenAccount: redeemVaultUsdcAta, // must equal config.redeem_vault
        redeemVaultAuthority: redeemVaultAuthorityPda,
        mint: wyldsMint,
        config: configPda,
        tokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers([operatorKeypair])
    .rpc();
```

`expectedAmount` is the amount the operator approved, and must equal the amount recorded on the request or the program rejects with `RedemptionAmountMismatch`. Take it from the approval record rather than re-reading the request: the `RedemptionRequest` PDA is keyed on the user alone, so a user can `cancel_redeem` a reviewed request and open a replacement for a different amount at the same address, and re-reading would simply approve whatever is there now.

Completion fails closed if the user's wYLDS balance is below the requested amount (`InsufficientRedemptionBalance`; request stays open) or the redeem vault holds less USDC than the request (`InsufficientVaultBalance`). `complete_redeem` must be the top-level instruction (see [§5](#5-cpi-rules)). Emits `RedeemCompleted` and closes the request, refunding rent to the user.

### 2c. `cancel_redeem` (user)

Lets the user withdraw their own pending request. Because completion requires the full requested amount to still be held, a user who moves wYLDS out after requesting must cancel before they can submit a new request. Refunds the request account's rent to the user and clears the burn delegate, but only when that delegate is still the `redeem_vault_authority` PDA — an unrelated approval the user granted afterwards is left alone.

```typescript
await vaultMint.methods
    .cancelRedeem()
    .accountsStrict({
        signer: userPublicKey,
        userMintTokenAccount: userWyldsAta,
        redemptionRequest: redemptionRequestPda,
        redeemVaultAuthority: redeemVaultAuthorityPda,
        config: configPda,
        tokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers([user])
    .rpc();
```

Callable only by the request's own owner, and works while the protocol is paused. If the wYLDS account is frozen, cancel succeeds only when there is no delegate to clear, since SPL Token rejects `Revoke` on frozen accounts — thaw first otherwise. Emits `RedemptionCancelled`.

---

## 3. Merkle reward claims (wYLDS)

Discrete reward epochs on **vault-mint**. Claims mint wYLDS on demand. Epochs at or above `first_capped_epoch` enforce an aggregate claim cap equal to the epoch’s declared `total`. Epochs created before the caps upgrade (below `first_capped_epoch`) remain claimable and uncapped, but no new epoch can be created at those indices.

### Epoch creation (operator)

`create_rewards_epoch(index, merkle_root, total)` is signed by the program **upgrade authority** (the Squads vault on mainnet), not a rewards administrator. One-time setup, both upgrade-authority instructions:

1. `initialize_epoch_caps(first_capped_epoch, max_epoch_cap)` — creates `EpochCapsConfig` (`[b"epoch_caps_config"]`).
2. `initialize_last_rewards_epoch(start_index)` — creates `LastRewardsEpoch` (`[b"last_rewards_epoch"]`). Requires `start_index + 1 >= first_capped_epoch`; typically `start_index = first_capped_epoch - 1`.

Each create then requires:

- `index == last_rewards_epoch.index + 1` (exact succession, `EpochIndexNotContiguous`)
- `index >= first_capped_epoch` (`EpochIndexBelowFirstCapped`)
- `0 < total <= max_epoch_cap` (`EpochCapAboveGlobal`)
- protocol not paused

Create initializes the `RewardsEpoch` (`[b"epoch", index_le]`) and `EpochClaimedAmount` (`[b"epoch_claimed", index_le]`) PDAs and emits `RewardsEpochCreated`. Recovery tools (upgrade authority): `update_last_rewards_epoch` fixes a wrongly seeded floor (same boundary check), `update_max_epoch_cap` changes the cap for future creates.

Squads scripts: `scripts/vault-mint/initialize_epoch_caps_proposal_squads.ts`, `scripts/vault-mint/initialize_last_rewards_epoch_proposal_squads.ts`.

### Leaf and proof format

**Leaf:** `sha256(user_pubkey || reward_amount_le_u64 || epoch_index_le_u64)`

The tree is built with `sortPairs: false` (positional, not sorted-pair hashing) and padded to a power of two with empty leaves. Each proof step is a `ProofNode`:

```typescript
type ProofNode = { sibling: number[] /* 32 bytes */; isLeft: boolean };

const proof: ProofNode[] = tree.getProof(leaf).map(p => ({
    sibling: Array.from(p.data),
    isLeft: p.position === "left",   // true → hash(sibling || node), false → hash(node || sibling)
}));
```

An all-zero sibling hashes the node alone. Off-chain builders should use `makeLeaf` / `allocationsToMerkleTree` in [`scripts/cryptolib.ts`](../scripts/cryptolib.ts); see [`scripts/vault-mint/claim_rewards.ts`](../scripts/vault-mint/claim_rewards.ts) for an end-to-end example.

### `claim_rewards` (user)

```typescript
const indexLe = new BN(epochIndex).toArrayLike(Buffer, "le", 8);

const [epochPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("epoch"), indexLe],
    vaultMintProgramId
);
const [epochCapsConfigPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("epoch_caps_config")],
    vaultMintProgramId
);
const [epochClaimedPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("epoch_claimed"), indexLe],
    vaultMintProgramId
);
const [claimRecordPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("claim"), epochPda.toBuffer(), userPublicKey.toBuffer()],
    vaultMintProgramId
);

await vaultMint.methods
    .claimRewards(new BN(rewardAmount), proof)
    .accountsStrict({
        config: configPda,
        user: userPublicKey,
        epoch: epochPda,
        epochCapsConfig: epochCapsConfigPda,
        epochClaimed: epochClaimedPda,
        claimRecord: claimRecordPda,
        mint: wyldsMint,
        mintAuthority: mintAuthorityPda,
        userMintTokenAccount: userWyldsAta,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers([user])
    .rpc();
```

The user pays rent for the permanent `ClaimRecord`, which blocks a second claim for the same epoch. Claims respect the mint pause flag. Emits `RewardsClaimed`.

---

## 4. External mint CPI (for stake programs)

Authorized stake programs call `external_program_mint` via CPI to mint wYLDS into a stake vault. Integrators normally use stake `publish_rewards` rather than calling this directly. Requirements:

- Must be invoked via CPI; a top-level call fails with `ExternalMintMustBeCpi`.
- The calling program must match the legacy `Config.allowed_external_mint_program` field or be listed in the `AllowedExternalMintPrograms` PDA (`[b"allowed_external_mint_programs", config]`). That PDA must be passed and must already exist on-chain, even if its list is empty.
- The caller signs with its own `external_mint_authority` PDA (`[b"external_mint_authority"]` under the calling program id).
- `admin` must be a signer on the outer transaction and listed in `rewards_administrators`.
- The mint program must not be paused.

Emits `ExternalProgramMintEvent`.

---

## 5. CPI rules

| Instructions | Invocation |
|--------------|------------|
| `deposit`, `request_redeem`, `cancel_redeem`, `claim_rewards` | Direct or CPI |
| `pause`, `freeze_token_account`, `thaw_token_account`, `complete_redeem`, `sweep_redeem_vault_funds` | Top-level only (`InstructionMustBeDirectInvocation`) |
| `external_program_mint` | CPI only (`ExternalMintMustBeCpi`) |
| Upgrade-authority instructions (`create_rewards_epoch`, config updates, epoch caps) | Direct or CPI (Squads `vaultTransactionExecute`) |

---

## 6. Troubleshooting

| Scenario | Check | Notes |
|----------|-------|-------|
| Deposit fails | `config.paused`; source ≠ deposit vault ATA; balances | Self-transfer deposits are rejected (`DepositSelfTransfer`) |
| `request_redeem` fails (duplicate) | Existing `RedemptionRequest` PDA | One pending request per user; `cancel_redeem` clears it |
| `request_redeem` fails (balance) | User wYLDS ATA ≥ requested amount | `InsufficientBalance` |
| `complete_redeem` fails (liquidity) | Redeem vault USDC balance | `InsufficientVaultBalance`; operator funds the redeem vault |
| `complete_redeem` fails (balance) | User wYLDS ATA ≥ request amount | `InsufficientRedemptionBalance`; user restores tokens or calls `cancel_redeem` |
| `complete_redeem` fails (burn) | User wYLDS ATA delegate | Delegate must still be `redeem_vault_authority`; user re-delegated → cancel and re-request |
| `complete_redeem` fails (`RedemptionAmountMismatch`) | `expected_amount` vs `RedemptionRequest.amount` | User replaced the request after approval; re-review the new amount before completing |
| `complete_redeem` fails (`InstructionMustBeDirectInvocation`) | Instruction position | Must be top-level, not wrapped in another program |
| `cancel_redeem` fails | wYLDS ATA frozen with a delegate set | SPL Token rejects `Revoke` on frozen accounts; thaw first |
| Claim fails (double claim) | `ClaimRecord` PDA | Permanent per epoch/user |
| Claim fails (`InvalidMerkleProof`) | Leaf + proof vs epoch root | `sha256(user \|\| amount_le \|\| index_le)`, positional `isLeft` |
| Claim fails (`EpochCapExceeded`) | `epoch_claimed.claimed_total` + amount vs `epoch.total` | Only for `index >= first_capped_epoch` |
| Create fails (`EpochIndexNotContiguous`) | `index` vs `last_rewards_epoch.index + 1` | Use the next index; fix a bad floor with `update_last_rewards_epoch` |
| Create fails (`EpochIndexBelowFirstCapped`) | `index` vs `first_capped_epoch` | Lower indices are reserved for pre-upgrade epochs |
| Create fails (`EpochCapAboveGlobal`) | `total` vs `max_epoch_cap` | Raise via `update_max_epoch_cap` or split the epoch |
| wYLDS → USDC pending | Operator queue / banking hours | Off-ramp is operator-managed |
| Account frozen | Freeze authority / TRM | Freeze admins can freeze/thaw wYLDS ATAs |

---

## 7. Events to monitor

| Event | Emitted by | Key fields |
|-------|-----------|------------|
| `DepositEvent` | `deposit` | `user`, `amount`, `mint`, `vault` |
| `RedemptionRequested` | `request_redeem` | `user`, `amount`, `vault_token_mint`, `mint` |
| `RedeemCompleted` | `complete_redeem` | `user`, `admin`, `amount`, `mint`, `vault` |
| `RedemptionCancelled` | `cancel_redeem` | `user`, `amount`, `mint`, `vault` |
| `RewardsEpochCreated` | `create_rewards_epoch` | `admin`, `index`, `merkle_root`, `total`, `created_ts` |
| `RewardsClaimed` | `claim_rewards` | `user`, `epoch`, `amount`, `mint`, `vault` |
| `ExternalProgramMintEvent` | `external_program_mint` | `admin`, `destination`, `amount`, `mint`, `vault` |
| `SweepRedeemVaultEvent` | `sweep_redeem_vault_funds` | `admin`, `destination`, `amount`, `vault` |

---

## 8. vs ETH vault-mint analogue

| Concept | ETH | Solana vault-mint |
|---------|-----|-------------------|
| Wrap | Deposit USDC, receive wYLDS | Same 1:1 `deposit` |
| Unwrap | `requestRedeem` / `completeRedeem` | Same two-step; wYLDS delegated at request, burned at completion; redeem vault is PDA-owned |
| Supplemental rewards | Merkle claim epochs | Mint-on-demand claims with per-epoch aggregate caps |
| Account model | ERC-20 approvals | Anchor ix + signed token transfers |
