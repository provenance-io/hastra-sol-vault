# Hastra SOL Integration Guide — vault-stake

Programmatic lifecycle for Hastra **stake pools** on Solana: deposit wYLDS, receive pool shares, redeem shares for wYLDS at a Chainlink-backed rate, and understand how yield is minted into the pool.

All stake pools share the same instruction surface and PDA seed strings. Only the **program id** and **share mint** change.

**Related docs**

- vault-mint (USDC ↔ wYLDS, merkle claims, USDC off-ramp): [`hastra-sol-vault-mint-integration-guide.md`](./hastra-sol-vault-mint-integration-guide.md)
- Operator addresses / config fields: [`Mainnet Solana Program Configuration Reference.md`](./Mainnet%20Solana%20Program%20Configuration%20Reference.md)

Codebase: https://github.com/provenance-io/hastra-sol-vault

---

## Pool registry

Program IDs match [`Anchor.toml`](../Anchor.toml). PRIME is the `vault-stake` program (`pool-prime` feature).

| Pool | Feature / binary | Mainnet program ID | Devnet program ID | Share token |
|------|------------------|--------------------|-------------------|-------------|
| PRIME | `pool-prime` | `97V7JsExNC6yFWu5KjK1FLfVkNVvtMpAFL5QkLWKEGxY` | same as mainnet | PRIME |
| AUTO | `pool-auto` (mainnet) / `pool-auto-devnet` (devnet) | `5uJgCDrQHfA58fPqLsuU14Srg9quxXNHz91cZ54cq4pK` | `B8FDo5EGA2hZ7YMugcw8wPHUYDBQJfNkEYpduXFLHfdZ` | AUTO |
| SMB | `pool-smb` | `FtpEAgur3VALsDw91PfNre82eXVrtgiDNf9EG3JeBd2r` | same as mainnet | SMB |

AUTO used different keypairs at deploy time, so its program id differs by cluster. Always pass the cluster-matching `--program_id` when targeting AUTO.

**CPI allow-list (vault-mint):** PRIME is typically authorized via mint config `allowed_external_mint_program`. AUTO / SMB are registered on the mint `AllowedExternalMintPrograms` PDA. Details: [configuration reference](./Mainnet%20Solana%20Program%20Configuration%20Reference.md).

Examples below use `vaultStakeProgramId` and `shareMint` — substitute from the table for your pool and cluster.

---

## Overview

Users deposit wYLDS into a **PDA-owned** stake vault ATA (`vault_authority`). The program mints share tokens at the current Chainlink rate. Yield is published by minting additional wYLDS into that same vault via CPI to vault-mint (`publish_rewards` → `external_program_mint`). Users realize yield when redeeming shares for more wYLDS per share as the oracle price appreciates.

**Exchange rate**

```
shares_to_mint  = deposit_wYLDS * price_scale / price
wYLDS_returned  = shares_burned * price / price_scale

where: price = (wYLDS per 1 share) * price_scale  [Chainlink Data Streams]
```

**PRIME product note:** Yield for the Democratized Prime / Demo Prime HELOC pool is generated off-chain on Provenance and bridged back as YLDS/wYLDS before `publish_rewards`. AUTO and SMB follow the same on-chain mechanics with their own off-chain yield sources.

---

## PDA derivations

Seeds are identical across pools; derive with the **pool’s** program id.

```typescript
const vaultStakeProgramId = new PublicKey("<POOL_PROGRAM_ID>"); // from registry

const [stakeConfigPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("stake_config")],
    vaultStakeProgramId
);
const [stakeVaultTokenAccountConfigPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("stake_vault_token_account_config"), stakeConfigPda.toBuffer()],
    vaultStakeProgramId
);
const [vaultAuthorityPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault_authority")],
    vaultStakeProgramId
);
const [mintAuthorityPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("mint_authority")],
    vaultStakeProgramId
);
const [stakePriceConfigPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("stake_price_config"), stakeConfigPda.toBuffer()],
    vaultStakeProgramId
);
const [stakeRewardConfigPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("stake_reward_config"), stakeConfigPda.toBuffer()],
    vaultStakeProgramId
);
```

---

## 1. Stake: wYLDS → shares

Requires a live Chainlink price on `StakePriceConfig` (`price_timestamp != 0` and within `price_max_staleness`).

```typescript
const vaultStake = new Program(idl, provider); // IDL is the same crate; program id = pool

await vaultStake.methods
    .deposit(new BN(amount))
    .accountsStrict({
        stakeConfig: stakeConfigPda,
        vaultTokenAccount: stakeVaultWyldsAta,       // PDA-owned wYLDS vault
        stakeVaultTokenAccountConfig: stakeVaultTokenAccountConfigPda,
        vaultAuthority: vaultAuthorityPda,
        mint: shareMint,                             // PRIME / AUTO / SMB mint
        vaultMint: wyldsMint,
        mintAuthority: mintAuthorityPda,
        signer: userPublicKey,
        userVaultTokenAccount: userWyldsAta,
        userMintTokenAccount: userShareAta,
        stakePriceConfig: stakePriceConfigPda,
        tokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers([user])
    .rpc();
```

---

## 2. Redeem: shares → wYLDS

Single-step: burns shares and transfers wYLDS from the stake vault. No unbonding period.

```typescript
await vaultStake.methods
    .redeem(new BN(shareAmount))
    .accountsStrict({
        stakeConfig: stakeConfigPda,
        vaultTokenAccount: stakeVaultWyldsAta,
        stakeVaultTokenAccountConfig: stakeVaultTokenAccountConfigPda,
        vaultAuthority: vaultAuthorityPda,
        signer: userPublicKey,
        ticket: vaultStakeProgramId,                 // pass program id if no legacy v1 ticket
        userVaultTokenAccount: userWyldsAta,
        userMintTokenAccount: userShareAta,
        mint: shareMint,
        vaultMint: wyldsMint,
        stakePriceConfig: stakePriceConfigPda,
        tokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers([user])
    .rpc();
```

> **Legacy:** Optional `ticket` supports deprecated v1 `UnbondingTicket` accounts. If none exists, pass the stake program id; Anchor treats it as `None`.

To convert wYLDS back to USDC, use vault-mint `request_redeem` / `complete_redeem` — see the [mint guide](./hastra-sol-vault-mint-integration-guide.md).

---

## 3. Yield: `publish_rewards`

Rewards administrators call `publish_rewards`, which CPIs vault-mint `external_program_mint` to mint wYLDS into the stake vault. Caps / cooldown live on `StakeRewardConfig`. Publication ids must be greater than the per-pool `LastRewardPublication.id` and within `MAX_GAP` of it (`RewardPublicationIdNotMonotonic` / `RewardPublicationIdGapTooLarge` otherwise). The counter is initialized once by the upgrade authority (`initialize_last_reward_publication`); a wrongly seeded floor is corrected with `update_last_reward_publication`. The admin must sign and be listed on **both** stake and mint rewards-admin lists.

Integrators typically only monitor this (and subsequent `verify_price`); they do not call it unless operating as a rewards admin.

---

## 4. Optional: merkle wYLDS claims

Supplemental merkle rewards are on **vault-mint**, not the stake program. Claim wYLDS there, then stake if desired. See [mint guide §3](./hastra-sol-vault-mint-integration-guide.md).

---

## 5. Troubleshooting

| Scenario | Check | Notes |
|----------|-------|-------|
| Deposit / redeem fails (pause) | `stakeConfig.paused` | Freeze admins can pause the pool |
| Deposit / redeem fails (price) | `stakePriceConfig.priceTimestamp`, `priceMaxStaleness` | Rewards admins must `verify_price` |
| Redeem fails (liquidity) | Stake vault wYLDS balance | Large exits may need a subsequent `publish_rewards` |
| Account frozen | Share mint freeze authority | Freeze admins / TRM |
| `publish_rewards` fails | Admin lists on stake **and** mint; mint pause; allow-list; caps; `LastRewardPublication` | Dual-list + CPI authorization |
| `RewardPublicationIdNotMonotonic` / `RewardPublicationIdGapTooLarge` | `last_reward_publication.id` vs `--reward_id` | Id must be `> last.id` and within `MAX_GAP` (10); counter is per pool |
| Publish stuck after bad `start_id` | `last_reward_publication.id` | Too-low / too-high floor vs next legitimate id; recover with `update_last_reward_publication` |

---

## 6. Events / logs to monitor

- **Deposit / Redeem** — share mint/burn and wYLDS vault movements
- **`publish_rewards` / External Program Mint** — yield minted into the pool
- **`verify_price`** — Chainlink rate refreshed; deposits/redeems unblocked if previously stale

---

## 7. vs ETH staking analogue

| Concept | ETH | Solana vault-stake |
|---------|-----|-------------------|
| Yield delivery | Manual merkle claim on vault | Accrues via oracle price; CPI mints wYLDS into PDA vault |
| Token model | Often single vault token | wYLDS (base) + pool shares |
| Share → base | Unbonding / queue variants | Immediate `redeem` |
| Price oracle | Separate NAV / feed contracts | `StakePriceConfig` + `verify_price` |
| Multiple pools | Separate deployments | Same code, distinct program ids (table above) |
