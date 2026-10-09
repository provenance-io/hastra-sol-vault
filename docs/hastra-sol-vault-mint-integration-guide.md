# Hastra SOL Integration Guide — vault-mint

Programmatic lifecycle for **vault-mint**: USDC ↔ wYLDS (1:1), operator-mediated USDC redemption, and merkle-based wYLDS reward claims.

**Program ID (mainnet / declared id):** `9WUyNREiPDMgwMh5Gt81Fd3JpiCKxpjZ5Dpq9Bo1RhMV`

Codebase: https://github.com/provenance-io/hastra-sol-vault

**Related docs**

- Stake pools (PRIME / AUTO / SMB): [`hastra-sol-vault-stake-integration-guide.md`](./hastra-sol-vault-stake-integration-guide.md)
- Operator addresses / config fields: [`Mainnet Solana Program Configuration Reference.md`](./Mainnet%20Solana%20Program%20Configuration%20Reference.md)

---

## Overview

wYLDS is the base-layer wrapped token on Solana: a 1:1 receipt for USDC deposited into the configured deposit vault token account. The deposit vault’s SPL **token authority** is configured at initialize (on mainnet this is treasury custody, not a mint PDA). The program still enforces minting rules and uses PDAs for mint authority, redeem-vault authority, and admin-gated flows.

| Flow | Instruction(s) | Result |
|------|----------------|--------|
| Mint | `deposit` | User USDC → deposit vault; user receives wYLDS 1:1 |
| Exit to USDC | `request_redeem` → `complete_redeem` | Burn wYLDS; operator pays USDC from redeem vault |
| Abandon an exit | `cancel_redeem` | User clears their own pending request; no funds move |
| Merkle rewards | `claim_rewards` (legacy: `claim_rewards`) | User receives wYLDS from epoch pool / mint path |

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

Resolve the live deposit / redeem vault ATAs and mint pubkeys from config (see the [configuration reference](./Mainnet%20Solana%20Program%20Configuration%20Reference.md) or `scripts/vault-mint/fetch_config.ts`).

---

## 1. Deposit: USDC → wYLDS

`deposit` transfers USDC from the user’s ATA into the configured deposit vault ATA and mints the same amount of wYLDS. The user’s source vault token account must differ from the deposit vault account (self-transfer deposits are rejected).

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

Two-step flow. Users burn wYLDS up front; USDC is paid later from the **redeem** vault (PDA-owned) after the operator funds it (e.g. via Circle CCTP). Batching minimums and banking-hours delays may apply.

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

Only one pending `RedemptionRequest` per user.

### 2b. `complete_redeem` (rewards administrator)

```typescript
await vaultMint.methods
    .completeRedeem(approvedAmount)
    .accountsStrict({
        admin: operatorPublicKey,
        user: userPublicKey,
        userMintTokenAccount: userWyldsAta,
        userVaultTokenAccount: userUsdcAta,
        redemptionRequest: redemptionRequestPda,
        redeemVaultTokenAccount: redeemVaultUsdcAta,
        redeemVaultAuthority: redeemVaultAuthorityPda,
        mint: wyldsMint,
        config: configPda,
        tokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers([operatorKeypair])
    .rpc();
```

`approvedAmount` is the amount the operator approved, and must equal the amount recorded on the request or the program rejects with `RedemptionAmountMismatch`. Take it from the approval record rather than re-reading the request: the `RedemptionRequest` PDA is keyed on the user alone, so a user can `cancel_redeem` a reviewed request and open a replacement for a different amount at the same address, and re-reading would simply approve whatever is there now.

Completion fails closed if the user's wYLDS balance is below the requested amount (request stays open).

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

Callable only by the request's own owner, and works while the protocol is paused. If the wYLDS account is frozen, cancel succeeds only when there is no delegate to clear, since SPL Token rejects `Revoke` on frozen accounts — thaw first otherwise.

---

## 3. Merkle reward claims (wYLDS)

Discrete reward epochs on **vault-mint**. `initialize_epoch_caps` is required on-chain before create/claim. After that, new epochs enforce an aggregate claim cap while still minting wYLDS on claim. Epochs created before the upgrade (below `first_capped_epoch`) remain claimable and uncapped, but no new epoch can be created at those indices.

**Leaf format:** `sha256(user_pubkey || reward_amount_le_bytes || epoch_index_le_bytes)`

After upgrade, call `initialize_epoch_caps(first_capped_epoch, max_epoch_cap)` once before any create/claim (Squads: `scripts/vault-mint/initialize_epoch_caps_proposal_squads.ts`). New epochs require `index == next_epoch_index` (contiguous from `first_capped_epoch`), `total <= max_epoch_cap`, and track claims in `epoch_claimed`.

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
    .claimRewards(new BN(rewardAmount), merkleProof)
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

Off-chain tree builders use `scripts/cryptolib.ts` (`makeLeaf` / `allocationsToMerkleTree`).

---

## 4. External mint CPI (for stake programs)

Authorized stake programs call `external_program_mint` via CPI to mint wYLDS into a stake vault. Callers must be on the legacy `allowed_external_mint_program` field and/or the `AllowedExternalMintPrograms` PDA. The `admin` account must be a **transaction signer** and listed in `rewards_administrators`. Integrators normally use stake `publish_rewards` rather than calling this directly.

---

## 5. Troubleshooting

| Scenario | Check | Notes |
|----------|-------|-------|
| Deposit fails | `config.paused`; source ≠ deposit vault ATA; balances | Self-transfer deposits are rejected |
| `request_redeem` fails (duplicate) | Existing `RedemptionRequest` PDA | One pending request per user; `cancel_redeem` clears it |
| `complete_redeem` fails (liquidity) | Redeem vault USDC balance | Operator funds the redeem vault |
| `complete_redeem` fails (balance) | User wYLDS ATA ≥ request amount | User must restore tokens, or `cancel_redeem`; request stays open |
| `complete_redeem` fails (`RedemptionAmountMismatch`) | `expected_amount` vs `RedemptionRequest.amount` | User replaced the request after approval; re-review the new amount before completing |
| `cancel_redeem` fails | wYLDS ATA frozen with a delegate set | SPL Token rejects `Revoke` on frozen accounts; thaw first |
| Claim fails (double claim) | `ClaimRecord` PDA | Permanent per epoch/user |
| Claim fails (proof) | Merkle leaf + proof vs epoch root | `sha256(user \|\| amount_le \|\| index_le)` |
| Claim fails (cap) | `epoch_claimed` + `epoch.total` | Only for `index >= first_capped_epoch` |
| Create fails (index) | `index` vs `caps.next_epoch_index` / `first_capped_epoch` | Must equal next (contiguous); below boundary reserved for pre-upgrade |
| wYLDS → USDC pending | Operator queue / banking hours | Off-ramp is operator-managed |
| Account frozen | Freeze authority / TRM | Freeze admins can freeze/thaw wYLDS ATAs |

---

## 6. Events / logs to monitor

- **Deposit** — USDC deposited, wYLDS minted
- **`request_redeem` / `complete_redeem` / `cancel_redeem`** — USDC off-ramp lifecycle, including abandoned requests
- **`create_rewards_epoch` / `claim_rewards`** — merkle reward availability and claims
- **`ExternalProgramMintEvent`** — stake-pool yield mint via CPI

---

## 7. vs ETH vault-mint analogue

| Concept | ETH | Solana vault-mint |
|---------|-----|-------------------|
| Wrap | Deposit USDC, receive wYLDS | Same 1:1 `deposit` |
| Unwrap | `requestRedeem` / `completeRedeem` | Same two-step; redeem vault is PDA-owned |
| Supplemental rewards | Merkle claim epochs | Mint-on-demand claims with per-epoch aggregate caps |
| Account model | ERC-20 approvals | Anchor ix + signed token transfers |
