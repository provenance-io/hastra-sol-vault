# Hastra Solana Vault Protocol — Curator Integration Guide

> This guide is for **curators** and **institutional integrators** who want to interact with the Hastra Vault Protocol on Solana, query vault state, or build tooling on top of it.

Codebase: https://github.com/provenance-io/hastra-sol-vault

---

## Table of Contents

1. [Protocol Overview](#1-protocol-overview)
2. [Program Addresses](#2-program-addresses)
3. [Token Model](#3-token-model)
4. [Core Vault Operations](#4-core-vault-operations)
   - 4.1 [Deposit USDC → Receive wYLDS (vault-mint)](#41-deposit-usdc--receive-wylds-vault-mint)
   - 4.2 [Two-Step Redemption: wYLDS → USDC](#42-two-step-redemption-wylds--usdc)
   - 4.3 [Stake wYLDS → Receive Pool Shares (vault-stake)](#43-stake-wylds--receive-pool-shares-vault-stake)
   - 4.4 [Instant Unstake: Shares → wYLDS](#44-instant-unstake-shares--wylds)
   - 4.5 [Claim Merkle Rewards (vault-mint)](#45-claim-merkle-rewards-vault-mint)
5. [Querying Vault State](#5-querying-vault-state)
6. [Share Price](#6-share-price)
7. [Access Control Roles](#7-access-control-roles)
8. [Compliance Controls](#8-compliance-controls)
9. [Events Reference](#9-events-reference)
10. [Error Reference](#10-error-reference)
11. [Transaction Cost Notes](#11-transaction-cost-notes)
12. [Notes](#12-notes)

---

## 1. Protocol Overview

The Hastra Solana Vault Protocol is two Anchor programs on Solana mainnet-beta. **vault-mint** wraps USDC into wYLDS. **vault-stake** is deployed once per pool (PRIME, AUTO, SMB) and stakes wYLDS into that pool's share token.

```
USDC ──▶ [vault-mint] ──▶ wYLDS ──▶ [vault-stake] ──▶ PRIME / AUTO / SMB
         (1:1 deposit)               (Chainlink share price)
```

| Program | Token | Ratio | Redemption |
|---------|-------|-------|------------|
| **vault-mint** | wYLDS | Always 1:1 with USDC | Two-step (rewards-admin `complete_redeem`) |
| **vault-stake** | PRIME, AUTO, or SMB | Set by the stored Chainlink price | Instant `redeem` |

Coming from the Ethereum vaults:

- There is no ERC-4626 `mint` / `withdraw` pair. Wrapping is `deposit`. Unwrapping is `request_redeem` then `complete_redeem`. Unstaking is a single `redeem`.
- `request_redeem` approves the redeem-vault authority as an SPL delegate. The wYLDS stays in the user's token account until `complete_redeem` burns it.
- Share conversions use the stored Chainlink price (`price / price_scale`), not `vault balance / share supply`.
- AUTO and SMB are the same stake program built with a different program id. Seeds and instructions match PRIME.

---

## 2. Program Addresses

### Mainnet

| Program | Program ID | Explorer |
|---------|------------|----------|
| vault-mint (wYLDS) | `9WUyNREiPDMgwMh5Gt81Fd3JpiCKxpjZ5Dpq9Bo1RhMV` | [View →](https://explorer.solana.com/address/9WUyNREiPDMgwMh5Gt81Fd3JpiCKxpjZ5Dpq9Bo1RhMV) |
| vault-stake PRIME | `97V7JsExNC6yFWu5KjK1FLfVkNVvtMpAFL5QkLWKEGxY` | [View →](https://explorer.solana.com/address/97V7JsExNC6yFWu5KjK1FLfVkNVvtMpAFL5QkLWKEGxY) |
| vault-stake AUTO | `5uJgCDrQHfA58fPqLsuU14Srg9quxXNHz91cZ54cq4pK` | [View →](https://explorer.solana.com/address/5uJgCDrQHfA58fPqLsuU14Srg9quxXNHz91cZ54cq4pK) |
| vault-stake SMB | `FtpEAgur3VALsDw91PfNre82eXVrtgiDNf9EG3JeBd2r` | [View →](https://explorer.solana.com/address/FtpEAgur3VALsDw91PfNre82eXVrtgiDNf9EG3JeBd2r) |

Devnet uses the same program ids, except AUTO: `B8FDo5EGA2hZ7YMugcw8wPHUYDBQJfNkEYpduXFLHfdZ`. Release IDLs are `idl/vault_mint.json`, `idl/vault_stake_prime.json`, `idl/vault_stake_auto.json`, `idl/vault_stake_auto_devnet.json`, and `idl/vault_stake_smb.json`.

> [!IMPORTANT]
> Build every instruction against the **program id**. It stays the same across Squads upgrades. A buffer address is only an upgrade artifact.

Token mints and vault token accounts are stored on-chain, not in this repo. Read them from the program accounts (or the fetch scripts under `scripts/vault-mint/` and `scripts/vault-stake/`):

| Value | Account field |
|-------|----------------|
| USDC mint | vault-mint `Config.vault` |
| wYLDS mint | vault-mint `Config.mint` |
| Deposit vault (USDC ATA) | `VaultTokenAccountConfig.vault_token_account` |
| Redeem vault (USDC ATA) | vault-mint `Config.redeem_vault` |
| Pool share mint (PRIME / AUTO / SMB) | that pool's `StakeConfig.mint` |
| Stake vault (wYLDS ATA) | that pool's `StakeVaultTokenAccountConfig.vault_token_account` |

---

## 3. Token Model

### wYLDS (vault-mint)

- **Decimals**: 6
- **Peg**: Hard 1:1 with USDC — `deposit` mints the same raw amount it transfers
- **Transferable**: Yes, until that token account is frozen
- **Minted by**: `deposit`, `claim_rewards`, and stake `publish_rewards` (via `external_program_mint`)
- **Burned by**: `complete_redeem`, using the delegate set in `request_redeem`

### PRIME, AUTO, and SMB (vault-stake shares)

- **Decimals**: 6
- **Peg**: Floating — wYLDS per share is the stored Chainlink price
- **Transferable**: Yes, until that token account is frozen
- **Minted by**: that pool's `deposit`
- **Burned by**: that pool's `redeem` (instant; no unbonding period)

Mint and burn authority for each of these tokens is a program PDA (`mint_authority`), not an approval granted to a vault contract.

### Share price (PRIME, AUTO, SMB)

```
shares_minted   = deposit_wYLDS * price_scale / price
wYLDS_returned  = shares_burned * price / price_scale

price = (wYLDS per 1 share) * price_scale
```

Both divisions round down. `publish_rewards` mints additional wYLDS into the stake vault. Holders realize that yield when the oracle price rises and they redeem.

Yield for the Democratized Prime / Demo Prime HELOC pool is generated off-chain on Provenance and bridged back as wYLDS before `publish_rewards`. AUTO and SMB use the same on-chain mechanics with their own off-chain yield sources.

---

## 4. Core Vault Operations

Examples use `@coral-xyz/anchor` and `@solana/spl-token`. Amounts are raw 6-decimal units (`1_000_000_000` = 1,000 tokens). The user's associated token accounts must already exist.

```typescript
import { BN, Program } from "@coral-xyz/anchor";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { PublicKey, SystemProgram } from "@solana/web3.js";

const VAULT_MINT = new PublicKey("9WUyNREiPDMgwMh5Gt81Fd3JpiCKxpjZ5Dpq9Bo1RhMV");
const VAULT_STAKE = new PublicKey("<POOL_PROGRAM_ID>"); // PRIME, AUTO, or SMB from the table above

const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], VAULT_MINT);
const [vaultTokenAccountConfigPda] = PublicKey.findProgramAddressSync(
  [Buffer.from("vault_token_account_config"), configPda.toBuffer()],
  VAULT_MINT
);
const [mintAuthorityPda] = PublicKey.findProgramAddressSync(
  [Buffer.from("mint_authority")],
  VAULT_MINT
);
const [redeemVaultAuthorityPda] = PublicKey.findProgramAddressSync(
  [Buffer.from("redeem_vault_authority")],
  VAULT_MINT
);

const [stakeConfigPda] = PublicKey.findProgramAddressSync(
  [Buffer.from("stake_config")],
  VAULT_STAKE
);
const [stakeVaultTokenAccountConfigPda] = PublicKey.findProgramAddressSync(
  [Buffer.from("stake_vault_token_account_config"), stakeConfigPda.toBuffer()],
  VAULT_STAKE
);
const [vaultAuthorityPda] = PublicKey.findProgramAddressSync(
  [Buffer.from("vault_authority")],
  VAULT_STAKE
);
const [stakeMintAuthorityPda] = PublicKey.findProgramAddressSync(
  [Buffer.from("mint_authority")],
  VAULT_STAKE
);
const [stakePriceConfigPda] = PublicKey.findProgramAddressSync(
  [Buffer.from("stake_price_config"), stakeConfigPda.toBuffer()],
  VAULT_STAKE
);
```

Load `wyldsMint`, `vaultUsdcAta`, and `redeemVaultUsdcAta` from vault-mint config. Load `shareMint` and `stakeVaultWyldsAta` from the pool you are targeting.

### 4.1 Deposit USDC → Receive wYLDS (vault-mint)

The user signs the USDC transfer inside `deposit`. There is no separate approve transaction.

```typescript
const vaultMint = new Program(mintIdl, provider);
const amount = new BN(1_000_000_000); // 1,000 USDC

await vaultMint.methods
  .deposit(amount)
  .accountsStrict({
    config: configPda,
    vaultTokenAccount: vaultUsdcAta,
    vaultTokenAccountConfig: vaultTokenAccountConfigPda,
    mint: wyldsMint,
    mintAuthority: mintAuthorityPda,
    signer: userPublicKey,
    userVaultTokenAccount: userUsdcAta,
    userMintTokenAccount: userWyldsAta,
    tokenProgram: TOKEN_PROGRAM_ID,
  })
  .rpc();
```

**Key facts**:

- No fee. 1,000 USDC deposits as 1,000 wYLDS.
- The source USDC account must not be the deposit vault itself (`DepositSelfTransfer`).
- Rejected while vault-mint is paused, and if the user's USDC or wYLDS account is frozen.

### 4.2 Two-Step Redemption: wYLDS → USDC

> [!IMPORTANT]
> There is no instant USDC withdrawal. `request_redeem` records the request and approves `redeem_vault_authority` as the SPL delegate for that amount. The wYLDS stays in the user's token account until a rewards administrator calls `complete_redeem`.

#### Step 1 — User: `request_redeem(amount)`

```typescript
const wyldsAmount = new BN(500_000_000); // 500 wYLDS
const [redemptionRequestPda] = PublicKey.findProgramAddressSync(
  [Buffer.from("redemption_request"), userPublicKey.toBuffer()],
  VAULT_MINT
);

await vaultMint.methods
  .requestRedeem(wyldsAmount)
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
  .rpc();
```

After this call the user still holds the wYLDS, with `redeem_vault_authority` approved to burn `wyldsAmount`. One `RedemptionRequest` PDA exists per user (`RequestAlreadyExists` on a second request). The user pays its rent. Emits `RedemptionRequested`.

Moving those tokens, or approving a different delegate (an SPL account has one delegate), makes the request impossible to complete until the user cancels it.

#### Step 2 — Off-chain (Hastra): Compliance + Fund Movement

The protocol operator:

1. Runs KYC/AML and sanctions screening
2. Funds the PDA-owned redeem vault with USDC (for example via Circle CCTP)
3. Calls `complete_redeem(expected_amount)` as a rewards administrator

Batching minimums and banking-hours delays may apply. Many integrators stop at wYLDS and skip USDC settlement.

```typescript
await vaultMint.methods
  .completeRedeem(expectedAmount)
  .accountsStrict({
    admin: operatorPublicKey,
    user: userPublicKey,
    userMintTokenAccount: userWyldsAta,
    userVaultTokenAccount: userUsdcAta,
    redemptionRequest: redemptionRequestPda,
    redeemVaultTokenAccount: redeemVaultUsdcAta, // must equal Config.redeem_vault
    redeemVaultAuthority: redeemVaultAuthorityPda,
    mint: wyldsMint,
    config: configPda,
    tokenProgram: TOKEN_PROGRAM_ID,
  })
  .signers([operatorKeypair])
  .rpc();
```

`expectedAmount` must equal `RedemptionRequest.amount` (`RedemptionAmountMismatch` otherwise). Take it from the approval record. The request PDA is keyed only on the user, so a user can cancel a reviewed request and open a new one for a different amount at the same address.

On success the program burns the wYLDS, pays the same amount of USDC from the redeem vault, emits `RedeemCompleted`, and closes the request (rent back to the user). It fails closed, and leaves the request open, when the user holds less than the requested wYLDS (`InsufficientRedemptionBalance`) or the redeem vault holds less USDC (`InsufficientVaultBalance`). `complete_redeem` must be the top-level instruction in the transaction.

#### Cancel — User: `cancel_redeem()`

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
  .rpc();
```

Only the request owner can cancel. It works while the protocol is paused, refunds the request rent, and revokes the delegate when that delegate is still `redeem_vault_authority`. A later, unrelated approval is left in place. If the wYLDS account is frozen, cancel succeeds only when there is no delegate to clear — SPL Token rejects `Revoke` on a frozen account. Emits `RedemptionCancelled`.

### 4.3 Stake wYLDS → Receive Pool Shares (vault-stake)

Use the pool's program id and IDL. PRIME, AUTO, and SMB share this instruction and these seeds.

```typescript
const vaultStake = new Program(stakeIdl, provider);
const amount = new BN(1_000_000_000); // 1,000 wYLDS

await vaultStake.methods
  .deposit(amount)
  .accountsStrict({
    stakeConfig: stakeConfigPda,
    vaultTokenAccount: stakeVaultWyldsAta,
    stakeVaultTokenAccountConfig: stakeVaultTokenAccountConfigPda,
    vaultAuthority: vaultAuthorityPda,
    mint: shareMint,
    vaultMint: wyldsMint,
    mintAuthority: stakeMintAuthorityPda,
    signer: userPublicKey,
    userVaultTokenAccount: userWyldsAta,
    userMintTokenAccount: userShareAta,
    stakePriceConfig: stakePriceConfigPda,
    tokenProgram: TOKEN_PROGRAM_ID,
  })
  .rpc();
```

**Key facts**:

- Shares minted = `amount * price_scale / price`, rounded down. Zero shares reverts with `DepositTooSmall`.
- Quote first with `assets_to_shares` ([§5](#quotes)). That view does not check price staleness; `deposit` does.
- Requires a live price: `price > 0`, `price_timestamp > 0`, and `now - price_timestamp <= price_max_staleness`.
- No unbonding period.

### 4.4 Instant Unstake: Shares → wYLDS

`redeem` burns the shares and transfers wYLDS from the stake vault in the same transaction.

```typescript
const shareAmount = new BN(100_000_000);

await vaultStake.methods
  .redeem(shareAmount)
  .accountsStrict({
    stakeConfig: stakeConfigPda,
    vaultTokenAccount: stakeVaultWyldsAta,
    stakeVaultTokenAccountConfig: stakeVaultTokenAccountConfigPda,
    vaultAuthority: vaultAuthorityPda,
    signer: userPublicKey,
    ticket: VAULT_STAKE, // program id when the user has no legacy v1 ticket
    userVaultTokenAccount: userWyldsAta,
    userMintTokenAccount: userShareAta,
    mint: shareMint,
    vaultMint: wyldsMint,
    stakePriceConfig: stakePriceConfigPda,
    tokenProgram: TOKEN_PROGRAM_ID,
  })
  .rpc();
```

wYLDS returned = `shareAmount * price / price_scale`, rounded down. The price check runs before the balance check. `InsufficientBalance` means the user holds fewer shares than requested. `InsufficientVaultBalance` means the stake vault cannot cover the payout.

> [!NOTE]
> `ticket` closes a deprecated v1 `UnbondingTicket` (`[b"ticket", user]`) and returns its rent when one still exists. Pass the stake program id when it does not; Anchor treats that as `None`.

To continue from wYLDS back to USDC, use [§4.2](#42-two-step-redemption-wylds--usdc).

### 4.5 Claim Merkle Rewards (vault-mint)

Bonus wYLDS for wYLDS holders is claimed per epoch. The operator publishes the merkle root with `create_rewards_epoch`. That instruction is signed by the program **upgrade authority** (the Squads vault on mainnet), not by a rewards administrator. New epochs must use `index == last_rewards_epoch.index + 1`, sit at or above `first_capped_epoch`, and declare `0 < total <= max_epoch_cap`. Claims against older, pre-cap epochs stay uncapped.

**Leaf:** `sha256(user_pubkey || amount_le_u64 || epoch_index_le_u64)`

Proof steps are positional (`sortPairs: false`). An all-zero sibling hashes the current node alone.

```typescript
type ProofNode = { sibling: number[]; isLeft: boolean };

const proof: ProofNode[] = tree.getProof(leaf).map((p) => ({
  sibling: Array.from(p.data),
  isLeft: p.position === "left",
}));

const indexLe = new BN(epochIndex).toArrayLike(Buffer, "le", 8);
const [epochPda] = PublicKey.findProgramAddressSync(
  [Buffer.from("epoch"), indexLe],
  VAULT_MINT
);
const [epochCapsConfigPda] = PublicKey.findProgramAddressSync(
  [Buffer.from("epoch_caps_config")],
  VAULT_MINT
);
const [epochClaimedPda] = PublicKey.findProgramAddressSync(
  [Buffer.from("epoch_claimed"), indexLe],
  VAULT_MINT
);
const [claimRecordPda] = PublicKey.findProgramAddressSync(
  [Buffer.from("claim"), epochPda.toBuffer(), userPublicKey.toBuffer()],
  VAULT_MINT
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
  .rpc();
```

The user pays rent for a permanent `ClaimRecord`, which blocks a second claim for that epoch. Epochs at or above `first_capped_epoch` also reject a claim that would push `epoch_claimed.claimed_total` past `epoch.total` (`EpochCapExceeded`). Build leaves with `makeLeaf` in `scripts/cryptolib.ts`.

---

## 5. Querying Vault State

Reads are account fetches. They succeed while the program is paused.

### vault-mint

```typescript
const config = await vaultMint.account.config.fetch(configPda);
// config.paused, config.vault (USDC mint), config.mint (wYLDS),
// config.redeemVault, config.freezeAdministrators, config.rewardsAdministrators

const vaultTokenConfig = await vaultMint.account.vaultTokenAccountConfig.fetch(
  vaultTokenAccountConfigPda
);
// vaultTokenConfig.vaultTokenAccount — deposit vault ATA

const pending = await vaultMint.account.redemptionRequest.fetchNullable(redemptionRequestPda);
// null, or { user, amount, mint }

const epoch = await vaultMint.account.rewardsEpoch.fetch(epochPda);
// epoch.index, epoch.merkleRoot, epoch.total, epoch.createdTs

const claimed = await vaultMint.account.claimRecord.fetchNullable(claimRecordPda);
// non-null means this user already claimed this epoch

const wyldsBalance = await connection.getTokenAccountBalance(userWyldsAta);
```

`LastRewardsEpoch` (`[b"last_rewards_epoch"]`) holds the highest epoch index accepted so far. The next create must use that index plus one.

### Stake pools

```typescript
const stakeConfig = await vaultStake.account.stakeConfig.fetch(stakeConfigPda);
// stakeConfig.paused, stakeConfig.vault (wYLDS mint), stakeConfig.mint (share mint)

const priceConfig = await vaultStake.account.stakePriceConfig.fetch(stakePriceConfigPda);
// priceConfig.price (i128), priceConfig.priceScale, priceConfig.priceTimestamp,
// priceConfig.priceMaxStaleness

const fresh =
  priceConfig.priceTimestamp.toNumber() > 0 &&
  priceConfig.price > 0 &&
  Math.floor(Date.now() / 1000) - priceConfig.priceTimestamp.toNumber() <=
    priceConfig.priceMaxStaleness.toNumber();

const shareBalance = await connection.getTokenAccountBalance(userShareAta);
```

`priceTimestamp` is the Chainlink report's `observationsTimestamp`, not the time `verify_price` landed.

### Quotes

`shares_to_assets`, `assets_to_shares`, and `exchange_rate` return a little-endian `u64` and require `price > 0`. They do **not** check staleness, so a quote can succeed while `deposit` or `redeem` fails with `PriceTooStale`.

| View | Result |
|------|--------|
| `shares_to_assets(shares)` | `shares * price / price_scale` |
| `assets_to_shares(assets)` | `assets * price_scale / price` |
| `exchange_rate()` | `price * 1_000_000_000 / price_scale` (wYLDS per share, scaled by 1e9) |

```typescript
const assetsOut = await vaultStake.methods
  .sharesToAssets(shareAmount)
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

## 6. Share Price

Each pool stores one Chainlink Data Streams price on `StakePriceConfig` (`[b"stake_price_config", stake_config]`).

```
Chainlink Data Streams
        │  (signed report)
        ▼
  verify_price ── rewards administrator; on-chain verifier CPI
        │  (stores price and observations_timestamp)
        ▼
  StakePriceConfig
        │
        ▼
  deposit / redeem ── shares = assets * price_scale / price
```

`deposit` and `redeem` reject the stored price unless `price > 0`, `price_timestamp > 0`, and `now - price_timestamp <= price_max_staleness`. Age is measured from the report observation time, so a report submitted late is already partly aged.

`verify_price` accepts a report only when its observation is strictly newer than the stored one, the report is inside its validity window, and the feed id matches the config. A rejected report leaves the stored price unchanged.

If the upgrade authority changes any `update_price_config` field other than `price_max_staleness` (Chainlink program, verifier, access controller, feed id, or `price_scale`), the stored price and timestamp are cleared and `PriceInvalidated` is emitted. Deposits and redeems stop until the next successful `verify_price`. A staleness-only update leaves the price in place.

`publish_rewards` mints wYLDS into the stake vault. It does not itself change `StakePriceConfig`. The share price moves when a later `verify_price` stores a new rate.

---

## 7. Access Control Roles

Solana uses two pubkey lists on each program config, plus the program upgrade authority. Lists hold 1–5 unique keys. There is no on-chain whitelist role.

| Authority | Ethereum analogue | Capability |
|-----------|-------------------|------------|
| Upgrade authority (Squads vault) | `DEFAULT_ADMIN_ROLE` + `UPGRADER_ROLE` | Upgrade the program. Create reward epochs and set epoch caps. Initialize and update price config and reward caps. |
| `freeze_administrators` | `FREEZE_ADMIN_ROLE` + `PAUSER_ROLE` | `freeze_token_account`, `thaw_token_account`, and `pause`. Each program has its own list. |
| `rewards_administrators` | `REWARDS_ADMIN_ROLE` | vault-mint: `complete_redeem`, `sweep_redeem_vault_funds` (USDC returns only to the configured deposit vault). Stake: `publish_rewards`, `verify_price`. `publish_rewards` also requires the signer to be on the vault-mint rewards list. |

Mainnet upgrade authority is the Squads vault `8fDTne6mBYfQXYHtsFWrBvrxUFqqXrFcJ83ZQwUBfmSD`.

`pause`, freeze, thaw, `complete_redeem`, `sweep_redeem_vault_funds`, `publish_rewards`, and `verify_price` must be the top-level instruction (`InstructionMustBeDirectInvocation`). User instructions (`deposit`, `request_redeem`, `cancel_redeem`, `claim_rewards`, stake `deposit` / `redeem`) may be invoked via CPI. `external_program_mint` is CPI-only.

```typescript
const config = await vaultMint.account.config.fetch(configPda);
const isFreezeAdmin = config.freezeAdministrators.some((k) => k.equals(address));
const isRewardsAdmin = config.rewardsAdministrators.some((k) => k.equals(address));
```

---

## 8. Compliance Controls

### Token-account freeze

Freeze is an SPL freeze on a **token account**, checked with `getAccount(...).isFrozen`. It is not a per-wallet flag. Freezing a user's wYLDS account does not freeze their PRIME account, and the reverse is also true. vault-mint freeze admins freeze wYLDS accounts. Each stake program's freeze admins freeze that pool's share accounts.

A frozen token account cannot send or receive that mint, so deposit, redeem, stake, unstake, and claim that touch it fail at the token program. Balances and program accounts remain readable. `cancel_redeem` cannot revoke a delegate on a frozen wYLDS account — thaw it first.

```typescript
import { getAccount } from "@solana/spl-token";

const wyldsAccount = await getAccount(connection, userWyldsAta);
if (wyldsAccount.isFrozen) {
  throw new Error("wYLDS account is frozen — contact compliance@hastra.io");
}
```

### Pause

Each program has its own `paused` flag, set by that program's freeze administrators.

While **vault-mint** is paused, `deposit`, `request_redeem`, `claim_rewards`, `create_rewards_epoch`, and `external_program_mint` fail with `ProtocolPaused`. `cancel_redeem` and `complete_redeem` still succeed.

While a **stake pool** is paused, that pool's `deposit`, `redeem`, and `publish_rewards` fail. Other pools are unaffected. Quote views and account reads still succeed.

```typescript
const { paused } = await vaultMint.account.config.fetch(configPda);
const { paused: stakePaused } = await vaultStake.account.stakeConfig.fetch(stakeConfigPda);
```

### Redeem-vault funds

USDC leaves the redeem vault only to the user in `complete_redeem`, or back to the configured deposit vault in `sweep_redeem_vault_funds`. There is no withdrawal whitelist.

---

## 9. Events Reference

### vault-mint

| Event | Fields | Description |
|-------|--------|-------------|
| `DepositEvent` | `user`, `amount`, `mint`, `vault` | USDC deposited, wYLDS minted |
| `RedemptionRequested` | `user`, `amount`, `vault_token_mint`, `mint` | User opened a redemption |
| `RedeemCompleted` | `user`, `admin`, `amount`, `mint`, `vault` | Admin burned wYLDS and paid USDC |
| `RedemptionCancelled` | `user`, `amount`, `mint`, `vault` | User withdrew a pending request |
| `RewardsClaimed` | `user`, `epoch`, `amount`, `mint`, `vault` | User claimed a merkle reward |
| `RewardsEpochCreated` | `admin`, `index`, `merkle_root`, `total`, `created_ts` | New reward epoch created |
| `ExternalProgramMintEvent` | `admin`, `destination`, `amount`, `mint`, `vault` | Stake `publish_rewards` minted wYLDS |
| `SweepRedeemVaultEvent` | `admin`, `destination`, `amount`, `vault` | USDC swept from the redeem vault |

### vault-stake (each pool)

| Event | Fields | Description |
|-------|--------|-------------|
| `DepositEvent` | `user`, `deposit_amount`, `minted_amount`, `vault_balance`, `total_assets`, `total_shares` | wYLDS staked, shares minted |
| `RedeemEvent` | `user`, `shares_burned`, `redeemed_vault_amount`, `total_assets`, `total_shares` | Shares burned, wYLDS returned |
| `RewardsPublished` | `admin`, `id`, `amount`, `vault_token_account`, `total_assets`, `total_shares` | Yield minted into the stake vault |
| `PriceVerifiedEvent` | `verifier`, `feed_id`, `price`, `price_scale`, `price_timestamp`, `expires_at` | Chainlink price stored |
| `PriceInvalidated` | `verifier`, `feed_id`, `price_scale` | Stored price cleared; deposit and redeem halt |

### Listening (Anchor)

```typescript
vaultMint.addEventListener("RedemptionRequested", (event) => {
  console.log(`${event.user.toBase58()} requested ${event.amount.toString()} wYLDS`);
});

vaultStake.addEventListener("RewardsPublished", (event) => {
  console.log(`Published ${event.amount.toString()} wYLDS, id ${event.id}`);
});
```

---

## 10. Error Reference

Anchor error names below are the ones curators hit on user and redemption flows.

| Error | Program | Cause | Resolution |
|-------|---------|-------|------------|
| `ProtocolPaused` | Both | That program is paused | Wait for a freeze admin to unpause |
| `DepositSelfTransfer` | vault-mint | USDC source is the deposit vault | Pass the user's own USDC account |
| `RequestAlreadyExists` | vault-mint | A `RedemptionRequest` is already open | Wait for `complete_redeem`, or `cancel_redeem` |
| `InsufficientBalance` | Both | Token account balance is below the requested amount | Lower the amount |
| `InsufficientRedemptionBalance` | vault-mint | User no longer holds the requested wYLDS | Restore the tokens, or `cancel_redeem` |
| `InsufficientVaultBalance` | Both | Redeem vault lacks USDC, or stake vault lacks wYLDS | Wait for the operator to fund it |
| `RedemptionAmountMismatch` | vault-mint | `expected_amount` ≠ the amount on the request | Re-read the request and approve the current amount |
| `InvalidMerkleProof` | vault-mint | Leaf or proof does not match the epoch root | Rebuild with `sha256(user \|\| amount_le \|\| index_le)` and positional `isLeft` |
| `EpochCapExceeded` | vault-mint | Claim would exceed the epoch `total` | Epoch is fully claimed |
| `PriceNotInitialized` | vault-stake | Stored price is zero or unset | Wait for `verify_price` |
| `PriceTooStale` | vault-stake | Observation is older than `price_max_staleness` | Wait for `verify_price` |
| `DepositTooSmall` | vault-stake | Deposit rounds down to zero shares | Increase the amount |
| `InstructionMustBeDirectInvocation` | Both | A privileged instruction was invoked via CPI | Submit it as the top-level instruction |

---

## 11. Transaction Cost Notes

Solana charges a base signature fee plus rent for new accounts. This repo does not publish compute-unit estimates; simulate the transaction before submitting it.

| Cost | Who pays | Refunded? |
|------|----------|-----------|
| `RedemptionRequest` rent | User, on `request_redeem` | Yes — to the user on `complete_redeem` or `cancel_redeem` |
| `ClaimRecord` rent | User, on `claim_rewards` | No — the record is permanent |
| User USDC, wYLDS, and share token accounts | Whoever created the ATAs | Accounts must exist before the instruction |

`deposit` and stake `deposit` transfer tokens with the user as signer. There is no preceding approve transaction. `request_redeem` sets the burn delegate inside the same instruction.

---

## 12. Notes

> [!CAUTION]
> **Always use the program id in [§2](#2-program-addresses).** It does not change when Squads upgrades the program. Buffer addresses do.

---

Last updated: 2026-10-09.
