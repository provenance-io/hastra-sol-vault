# Hastra SOL Integration Guide — vault-stake

Programmatic lifecycle for Hastra **stake pools** on Solana: deposit wYLDS, receive pool shares, redeem shares for wYLDS at a Chainlink-backed rate, and understand how yield is minted into the pool.

All stake pools share the same instruction surface and PDA seed strings. Only the **program id** and **share mint** change.

**Related docs**

- vault-mint (USDC ↔ wYLDS, merkle claims, USDC off-ramp): [`hastra-sol-vault-mint-integration-guide.md`](./hastra-sol-vault-mint-integration-guide.md)
- Live config fields: [`scripts/vault-stake/fetch_stake_vault_token_account_config.ts`](../scripts/vault-stake/fetch_stake_vault_token_account_config.ts), [`fetch_stake_reward_config.ts`](../scripts/vault-stake/fetch_stake_reward_config.ts), [`fetch_last_reward_publication.ts`](../scripts/vault-stake/fetch_last_reward_publication.ts)

Codebase: https://github.com/provenance-io/hastra-sol-vault

---

## Pool registry

Program IDs match [`Anchor.toml`](../Anchor.toml). PRIME is the `vault-stake` program (`pool-prime` feature).

| Pool | Feature / binary | Mainnet program ID | Devnet program ID | Share token |
|------|------------------|--------------------|-------------------|-------------|
| PRIME | `pool-prime` | `97V7JsExNC6yFWu5KjK1FLfVkNVvtMpAFL5QkLWKEGxY` | same as mainnet | PRIME |
| AUTO | `pool-auto` (mainnet) / `pool-auto-devnet` (devnet) | `5uJgCDrQHfA58fPqLsuU14Srg9quxXNHz91cZ54cq4pK` | `B8FDo5EGA2hZ7YMugcw8wPHUYDBQJfNkEYpduXFLHfdZ` | AUTO |
| SMB | `pool-smb` | `FtpEAgur3VALsDw91PfNre82eXVrtgiDNf9EG3JeBd2r` | same as mainnet | SMB |

AUTO used different keypairs at deploy time, so its program id differs by cluster. Always pass the cluster-matching `--program_id` when targeting AUTO. Release artifacts ship one IDL per program id (`idl/vault_stake_prime.json`, `vault_stake_auto.json`, `vault_stake_auto_devnet.json`, `vault_stake_smb.json`).

**CPI allow-list (vault-mint):** PRIME is typically authorized via mint config `allowed_external_mint_program`. AUTO / SMB are registered on the mint `AllowedExternalMintPrograms` PDA. Inspect both with `scripts/vault-mint/fetch_external_mint_pdas.ts`.

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

Both divisions round down. A deposit that rounds to zero shares fails with `DepositTooSmall`; a redeem that rounds to zero wYLDS fails with `InvalidAmount`.

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
const [lastRewardPublicationPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("last_reward_publication"), stakeConfigPda.toBuffer()],
    vaultStakeProgramId
);
```

The stake vault wYLDS ATA is `StakeVaultTokenAccountConfig.vault_token_account`.

---

## 1. Price freshness

`deposit` and `redeem` read the stored price on `StakePriceConfig` and reject it unless all of these hold:

- `price_timestamp != 0` and `price > 0` (`PriceNotInitialized` otherwise)
- `now - price_timestamp <= price_max_staleness` (`PriceTooStale` otherwise)

`price_timestamp` is the Chainlink report’s `observations_timestamp`, not the time `verify_price` landed, so a report submitted late is already partly aged. Rewards administrators refresh the price with `verify_price`, which also rejects a report whose observation is not strictly newer than the stored one (`ObservationTimestampNotIncreasing`), is outside its validity window (`ReportStale`, `FutureReportValidFromTimestamp`, `FutureObservationTimestamp`), or carries the wrong feed (`InvalidFeedId`).

If the upgrade authority changes any `update_price_config` field other than `price_max_staleness` (Chainlink program, verifier, access controller, feed id, or `price_scale`), the stored price and timestamp are zeroed and `PriceInvalidated` is emitted. Deposits and redeems halt until the next successful `verify_price`. A staleness-only update leaves the price intact.

---

## 2. Stake: wYLDS → shares

```typescript
const vaultStake = new Program(idl, provider); // IDL for this pool's program id

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

Emits `DepositEvent`.

---

## 3. Redeem: shares → wYLDS

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

The price check runs before the balance check, so a stale oracle fails first regardless of the user's holdings. Fails with `InsufficientBalance` if the user holds fewer shares than requested, or `InsufficientVaultBalance` if the stake vault cannot cover the payout. Emits `RedeemEvent`.

> **Legacy:** Optional `ticket` supports deprecated v1 `UnbondingTicket` accounts (`[b"ticket", user]`). If one exists, pass it and it is closed with rent returned to the user. If none exists, pass the stake program id; Anchor treats it as `None`.

To convert wYLDS back to USDC, use vault-mint `request_redeem` / `complete_redeem` — see the [mint guide](./hastra-sol-vault-mint-integration-guide.md).

---

## 4. Quote views

`shares_to_assets`, `assets_to_shares`, and `exchange_rate` compute conversions from the stored price without moving funds. They require `price > 0` but do **not** check staleness, so a quote can succeed while a deposit or redeem would fail with `PriceTooStale`. Each returns a `u64` through return data (little-endian), readable via simulation.

| View | Result |
|------|--------|
| `shares_to_assets(shares)` | `shares * price / price_scale` |
| `assets_to_shares(assets)` | `assets * price_scale / price` |
| `exchange_rate()` | `price * 1_000_000_000 / price_scale` (wYLDS per share, scaled by 1e9) |

```typescript
const quote = await vaultStake.methods
    .sharesToAssets(new BN(shareAmount))
    .accountsStrict({
        stakeConfig: stakeConfigPda,
        mint: shareMint,
        vaultTokenAccount: stakeVaultWyldsAta,
        vaultAuthority: vaultAuthorityPda,
        stakePriceConfig: stakePriceConfigPda,
    })
    .view();
```

---

## 5. Yield: `publish_rewards`

Rewards administrators call `publish_rewards(id, amount)`, which CPIs vault-mint `external_program_mint` to mint wYLDS into the stake vault. Integrators typically only monitor this (and `verify_price`); they do not call it unless operating as a rewards admin.

Requirements:

- Must be the top-level instruction (`InstructionMustBeDirectInvocation`).
- Neither the stake pool nor vault-mint may be paused.
- The admin signs and is listed on **both** the stake and mint `rewards_administrators`.
- The pool must be authorized on vault-mint (legacy field or `AllowedExternalMintPrograms`), and the mint allow-list PDA must be passed and exist.
- `id > LastRewardPublication.id` and `id - LastRewardPublication.id <= MAX_GAP` (255); otherwise `RewardPublicationIdNotMonotonic` / `RewardPublicationIdGapTooLarge`. The counter is per pool, initialized once by the upgrade authority (`initialize_last_reward_publication`) and corrected with `update_last_reward_publication`.
- Each publication creates a `RewardPublicationRecord` at `[b"reward_record", id_le_u32, amount_le_u64]`.

`StakeRewardConfig` limits (defaults set by `initialize_stake_reward_config`, changeable by the upgrade authority):

| Field | Default | Error |
|-------|---------|-------|
| `max_reward_bps` (of current vault balance; skipped when the vault is empty) | 75 (0.75%) | `RewardExceedsMaxDelta` |
| `max_period_rewards` (per call) | 1,000,000 wYLDS | `ExceedsPeriodRewardCap` |
| `reward_period_seconds` (cooldown since last publish) | 3540 (59 min) | `RewardCooldownNotElapsed` |
| `max_total_rewards` (lifetime) | 10,000,000 wYLDS | `ExceedsLifetimeRewardCap` |

Emits `RewardsPublished`.

---

## 6. Optional: merkle wYLDS claims

Supplemental merkle rewards are on **vault-mint**, not the stake program. Claim wYLDS there, then stake if desired. See [mint guide §3](./hastra-sol-vault-mint-integration-guide.md#3-merkle-reward-claims-wylds).

---

## 7. Troubleshooting

| Scenario | Check | Notes |
|----------|-------|-------|
| Deposit / redeem fails (`ProtocolPaused`) | `stakeConfig.paused` | Freeze admins can pause the pool |
| Deposit / redeem fails (`PriceNotInitialized`) | `stakePriceConfig.price`, `priceTimestamp` | Never verified, or cleared by `update_price_config`; rewards admin must `verify_price` |
| Deposit / redeem fails (`PriceTooStale`) | `now - priceTimestamp` vs `priceMaxStaleness` | Age is measured from the report observation time |
| Deposit fails (`DepositTooSmall`) | Amount vs price | Deposit rounds to zero shares |
| Redeem fails (`InsufficientVaultBalance`) | Stake vault wYLDS balance | Large exits may need a subsequent `publish_rewards` |
| Quote succeeds but deposit fails | Staleness | Views skip the staleness check |
| Account frozen | Share mint freeze authority | Freeze admins / TRM |
| `verify_price` fails (`ObservationTimestampNotIncreasing`) | Report vs stored `priceTimestamp` | Submit a newer report |
| `publish_rewards` fails (authorization) | Admin on stake **and** mint lists; mint pause; allow-list | Dual-list + CPI authorization |
| `publish_rewards` fails (caps) | `StakeRewardConfig` fields and `total_rewards_distributed` | See the limits table above |
| `RewardPublicationIdNotMonotonic` / `RewardPublicationIdGapTooLarge` | `last_reward_publication.id` vs `--reward_id` | Id must be `> last.id` and within `MAX_GAP` (255); counter is per pool |
| Publish stuck after bad `start_id` | `last_reward_publication.id` | Recover with `update_last_reward_publication` |

---

## 8. Events to monitor

| Event | Emitted by | Key fields |
|-------|-----------|------------|
| `DepositEvent` | `deposit` | `user`, `deposit_amount`, `minted_amount`, `vault_balance`, `total_assets`, `total_shares` |
| `RedeemEvent` | `redeem` | `user`, `shares_burned`, `redeemed_vault_amount`, `total_assets`, `total_shares` |
| `RewardsPublished` | `publish_rewards` | `admin`, `id`, `amount`, `vault_token_account`, `total_assets`, `total_shares` |
| `PriceVerifiedEvent` | `verify_price` | `verifier`, `feed_id`, `price`, `price_scale`, `price_timestamp`, `expires_at` |
| `PriceInvalidated` | `update_price_config` | `verifier`, `feed_id`, `price_scale` — deposits/redeems halted until next `verify_price` |

vault-mint also emits `ExternalProgramMintEvent` for each `publish_rewards`.

---

## 9. vs ETH staking analogue

| Concept | ETH | Solana vault-stake |
|---------|-----|-------------------|
| Yield delivery | Manual merkle claim on vault | Accrues via oracle price; CPI mints wYLDS into PDA vault |
| Token model | Often single vault token | wYLDS (base) + pool shares |
| Share → base | Unbonding / queue variants | Immediate `redeem` |
| Price oracle | Separate NAV / feed contracts | `StakePriceConfig` + `verify_price` |
| Multiple pools | Separate deployments | Same code, distinct program ids (table above) |
