/**
 * Localnet helper: redeem on vault-stake (PRIME) or vault-stake-auto (share token).
 * Burns staking mint shares and sends wYLDS (vault mint) to the signer's ATA.
 *
 * After publish_rewards increases the pool vault, users still call this instruction
 * to exit: amount is in raw staking-token units (same decimals as PRIME / share mint).
 *
 * Mints and pool vault default from on-chain stake_config (not only .env), so they stay
 * aligned with vault-stake deposit. The wYLDS associated token account is created if
 * missing. PRIME/stake ATA must already exist: use ANCHOR_WALLET = depositor keypair.
 */

import * as anchor from "@coral-xyz/anchor";
import {AnchorProvider, BN, Program} from "@coral-xyz/anchor";
import {
    ASSOCIATED_TOKEN_PROGRAM_ID,
    TOKEN_PROGRAM_ID,
    createAssociatedTokenAccountInstruction,
    getAccount,
    getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {Transaction} from "@solana/web3.js";
import yargs from "yargs";
import {VaultStake} from "../../target/types/vault_stake";
import {VaultStakeAuto} from "../../target/types/vault_stake_auto";
import {defaultLocalValidatorEnvPath, loadEnvFile} from "./local_validator_config";

type StakeProgram = Program<VaultStake> | Program<VaultStakeAuto>;

function pickAddr(
    cli: string | undefined,
    envKey: string,
    fileEnv: Record<string, string>
): string | undefined {
    if (cli) {
        return cli;
    }
    const fromProcess = process.env[envKey];
    if (fromProcess) {
        return fromProcess;
    }
    return fileEnv[envKey];
}

function requireAddr(
    name: string,
    value: string | undefined
): anchor.web3.PublicKey {
    if (!value) {
        throw new Error(
            `Missing ${name}: pass the corresponding CLI flag or set it in the environment / .env file`
        );
    }
    return new anchor.web3.PublicKey(value);
}

const args = yargs(process.argv.slice(2))
    .option("pool", {
        type: "string",
        choices: ["prime", "auto"],
        default: "prime",
        description: "prime = vault-stake; auto = vault-stake-auto",
    })
    .option("env_file", {
        type: "string",
        default: defaultLocalValidatorEnvPath(),
        description: "Dotenv-style file for default mint / vault addresses",
    })
    .option("stake_program", {
        type: "string",
        description:
            "Optional: must match workspace program if set (default STAKE_* from .env)",
    })
    .option("mint", {
        type: "string",
        description:
            "Override staking mint; default from on-chain stake_config (else STAKE_* from .env)",
    })
    .option("vault_mint", {
        type: "string",
        description:
            "Override vault mint (wYLDS); default from on-chain stake_config (else MINT_TOKEN)",
    })
    .option("vault_token_account", {
        type: "string",
        description:
            "Override pool vault ATA; default from on-chain config (else STAKE_*_VAULT_TOKEN_ACCOUNT)",
    })
    .option("user_mint_token_account", {
        type: "string",
        description:
            "Override: user's ATA for staking mint (default: ATA of signer for staking mint)",
    })
    .option("user_vault_token_account", {
        type: "string",
        description:
            "Override: user's ATA for wYLDS (default: ATA of signer for vault mint)",
    })
    .option("amount", {
        type: "number",
        description: "Raw amount of staking tokens to burn (must be <= balance)",
        required: true,
    })
    .parseSync();

function selectProgram(pool: string): StakeProgram {
    if (pool === "auto") {
        return anchor.workspace.VaultStakeAuto as Program<VaultStakeAuto>;
    }
    return anchor.workspace.VaultStake as Program<VaultStake>;
}

/**
 * Create the SPL associated token account for (mint, owner) when absent (payer = owner).
 */
async function ensureAssociatedTokenAccount(
    provider: AnchorProvider,
    mint: anchor.web3.PublicKey,
    owner: anchor.web3.PublicKey
): Promise<anchor.web3.PublicKey> {
    const ata = getAssociatedTokenAddressSync(mint, owner);
    const info = await provider.connection.getAccountInfo(ata);
    if (info !== null) {
        return ata;
    }
    const ix = createAssociatedTokenAccountInstruction(
        owner,
        ata,
        owner,
        mint,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
    );
    await provider.sendAndConfirm(new Transaction().add(ix));
    console.log("Created ATA for mint", mint.toBase58(), "→", ata.toBase58());
    return ata;
}

async function main() {
    const fileEnv = loadEnvFile(args.env_file);
    const pool = args.pool as string;

    const provider = AnchorProvider.env();
    anchor.setProvider(provider);

    const program = selectProgram(pool);
    const thisProgramId = program.programId;

    const stakeProgramStr =
        pool === "auto"
            ? pickAddr(args.stake_program, "STAKE_AUTO_PROGRAM_ID", fileEnv)
            : pickAddr(args.stake_program, "STAKE_PROGRAM_ID", fileEnv);
    if (stakeProgramStr !== undefined) {
        const stakeProgramId = new anchor.web3.PublicKey(stakeProgramStr);
        if (!stakeProgramId.equals(thisProgramId)) {
            throw new Error(
                `stake_program (${stakeProgramId.toBase58()}) must match workspace program for --pool ${pool} (${thisProgramId.toBase58()}).`
            );
        }
    }

    const [stakeConfigPda] = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("stake_config")],
        thisProgramId
    );
    const [vaultAuthorityPda] = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("vault_authority")],
        thisProgramId
    );
    const [stakeVaultTokenAccountConfigPda] =
        anchor.web3.PublicKey.findProgramAddressSync(
            [
                Buffer.from("stake_vault_token_account_config"),
                stakeConfigPda.toBuffer(),
            ],
            thisProgramId
        );
    const [stakePriceConfigPda] = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("stake_price_config"), stakeConfigPda.toBuffer()],
        thisProgramId
    );

    const signer = provider.wallet.publicKey;

    let mint: anchor.web3.PublicKey;
    let vaultMint: anchor.web3.PublicKey;
    let vaultTokenAccount: anchor.web3.PublicKey;
    let addressSource: string;

    try {
        const stakeCfg = await program.account.stakeConfig.fetch(stakeConfigPda);
        const vaultCfg =
            await program.account.stakeVaultTokenAccountConfig.fetch(
                stakeVaultTokenAccountConfigPda
            );
        mint = args.mint
            ? new anchor.web3.PublicKey(args.mint)
            : stakeCfg.mint;
        vaultMint = args.vault_mint
            ? new anchor.web3.PublicKey(args.vault_mint)
            : stakeCfg.vault;
        vaultTokenAccount = args.vault_token_account
            ? new anchor.web3.PublicKey(args.vault_token_account)
            : vaultCfg.vaultTokenAccount;
        addressSource = "on-chain stake_config / stake_vault_token_account_config";
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(
            "On-chain fetch of stake_config failed; using .env / CLI. Reason:",
            msg
        );
        mint = requireAddr(
            pool === "auto" ? "mint / STAKE_AUTO_TOKEN" : "mint / STAKE_TOKEN",
            pool === "auto"
                ? pickAddr(args.mint, "STAKE_AUTO_TOKEN", fileEnv)
                : pickAddr(args.mint, "STAKE_TOKEN", fileEnv)
        );
        vaultMint = requireAddr(
            "vault_mint / MINT_TOKEN",
            pickAddr(args.vault_mint, "MINT_TOKEN", fileEnv)
        );
        vaultTokenAccount = requireAddr(
            pool === "auto"
                ? "vault_token_account / STAKE_AUTO_VAULT_TOKEN_ACCOUNT"
                : "vault_token_account / STAKE_VAULT_TOKEN_ACCOUNT",
            pool === "auto"
                ? pickAddr(
                      args.vault_token_account,
                      "STAKE_AUTO_VAULT_TOKEN_ACCOUNT",
                      fileEnv
                  )
                : pickAddr(
                      args.vault_token_account,
                      "STAKE_VAULT_TOKEN_ACCOUNT",
                      fileEnv
                  )
        );
        addressSource = ".env / CLI (fetch stake accounts failed)";
    }

    let userMintTokenAccount: anchor.web3.PublicKey;
    if (args.user_mint_token_account !== undefined) {
        userMintTokenAccount = new anchor.web3.PublicKey(
            args.user_mint_token_account
        );
    } else {
        userMintTokenAccount = getAssociatedTokenAddressSync(mint, signer);
    }

    let userVaultTokenAccount: anchor.web3.PublicKey;
    if (args.user_vault_token_account !== undefined) {
        userVaultTokenAccount = new anchor.web3.PublicKey(
            args.user_vault_token_account
        );
    } else {
        userVaultTokenAccount = await ensureAssociatedTokenAccount(
            provider,
            vaultMint,
            signer
        );
    }

    const stakeMintInfo =
        await provider.connection.getAccountInfo(userMintTokenAccount);
    if (stakeMintInfo === null) {
        throw new Error(
            `user_mint_token_account (staking / PRIME ATA) is not initialized: ${userMintTokenAccount.toBase58()}.\n` +
                `Use ANCHOR_WALLET pointing to the same keypair you used for vault-stake deposit (the wallet that received PRIME).\n` +
                `If you only ran publish_rewards, that signer has no PRIME — switch to your depositor wallet.`
        );
    }

    const [ticketPda] = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("ticket"), signer.toBuffer()],
        thisProgramId
    );
    const legacyTicketInfo = await provider.connection.getAccountInfo(ticketPda);
    const ticketAccount =
        legacyTicketInfo !== null ? ticketPda : thisProgramId;

    // Do not use BN(n, 10, "le") with a JS number: bn.js byte-reverses and corrupts the value.
    const amountBn = new BN(String(Math.trunc(args.amount)), 10);

    const userStakeTokenAcc = await getAccount(
        provider.connection,
        userMintTokenAccount,
        "confirmed",
        TOKEN_PROGRAM_ID
    );
    const primeBalanceRaw = userStakeTokenAcc.amount;
    if (amountBn.gt(new BN(primeBalanceRaw.toString()))) {
        throw new Error(
            `Redeem --amount (${amountBn.toString()} raw) exceeds staking-mint balance (${primeBalanceRaw.toString()} raw) ` +
                `in ${userMintTokenAccount.toBase58()}.\n` +
                `processor.rs:216 requires amount <= that balance. With 6 decimals, 1 PRIME = 1_000_000 raw.`
        );
    }

    console.log("=== redeem (localnet) ===\n");
    console.log("Pool:                   ", pool);
    console.log("Program ID:             ", thisProgramId.toBase58());
    console.log("Signer:                 ", signer.toBase58());
    console.log("Address source:         ", addressSource);
    console.log("Staking mint (burn):    ", mint.toBase58());
    console.log("Vault mint (wYLDS):     ", vaultMint.toBase58());
    console.log("Pool vault ATA:         ", vaultTokenAccount.toBase58());
    console.log("User staking ATA:       ", userMintTokenAccount.toBase58());
    console.log("Staking mint balance:   ", primeBalanceRaw.toString(), "raw");
    console.log("User wYLDS ATA:         ", userVaultTokenAccount.toBase58());
    console.log("Redeem amount (raw):    ", amountBn.toString());
    console.log(
        "Legacy ticket:          ",
        ticketPda.toBase58(),
        legacyTicketInfo !== null ? "(will close)" : "(none)"
    );
    console.log();

    const tx = await program.methods
        .redeem(amountBn)
        .accountsStrict({
            stakeConfig: stakeConfigPda,
            stakeVaultTokenAccountConfig: stakeVaultTokenAccountConfigPda,
            stakePriceConfig: stakePriceConfigPda,
            vaultTokenAccount: vaultTokenAccount,
            vaultAuthority: vaultAuthorityPda,
            signer: signer,
            ticket: ticketAccount,
            userVaultTokenAccount: userVaultTokenAccount,
            userMintTokenAccount: userMintTokenAccount,
            mint: mint,
            vaultMint: vaultMint,
            tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        })
        .rpc();

    console.log("Transaction:", tx);
}

main().catch(console.error);
