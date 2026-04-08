/**
 * Localnet helper: publishRewards for either the PRIME pool (vault-stake) or
 * AUTO pool (vault-stake-auto). Addresses default from environment variables
 * (e.g. after sourcing scripts/.local-validator/.env) or from CLI flags.
 *
 * With --use_local_validator_config, the rewards admin keypair is read from
 * scripts/.local-validator/config.json so ANCHOR_WALLET need not be set.
 */

import * as anchor from "@coral-xyz/anchor";
import {AnchorProvider, BN, Program, Wallet} from "@coral-xyz/anchor";
import {createBigInt} from "@metaplex-foundation/umi";
import {Connection} from "@solana/web3.js";
import yargs from "yargs";
import {VaultStake} from "../../target/types/vault_stake";
import {VaultStakeAuto} from "../../target/types/vault_stake_auto";
import {
    defaultLocalValidatorConfigPath,
    defaultLocalValidatorEnvPath,
    keypairFromConfigSecret,
    loadEnvFile,
    readLocalValidatorConfig,
} from "./local_validator_config";

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
    .option("use_local_validator_config", {
        type: "boolean",
        default: false,
        description:
            "Sign with rewardsAdmin from config.json; RPC from ANCHOR_PROVIDER_URL, RPC_URL, config, or .env",
    })
    .option("local_validator_config", {
        type: "string",
        default: defaultLocalValidatorConfigPath(),
        description: "Path to local validator config.json",
    })
    .option("env_file", {
        type: "string",
        default: defaultLocalValidatorEnvPath(),
        description: "Dotenv-style file for default addresses (optional)",
    })
    .option("mint_program", {
        type: "string",
        description: "Hastra mint program; default MINT_PROGRAM_ID",
    })
    .option("stake_program", {
        type: "string",
        description:
            "This staking program; default STAKE_PROGRAM_ID (prime) or STAKE_AUTO_PROGRAM_ID (auto)",
    })
    .option("rewards_mint", {
        type: "string",
        description: "Rewards token mint (e.g. wYLDS); default MINT_TOKEN",
    })
    .option("mint", {
        type: "string",
        description:
            "Staking token mint (PRIME or share); default STAKE_TOKEN or STAKE_AUTO_TOKEN",
    })
    .option("vault_token_account", {
        type: "string",
        description:
            "Pool vault ATA for rewards mint; default STAKE_VAULT_TOKEN_ACCOUNT or STAKE_AUTO_VAULT_TOKEN_ACCOUNT",
    })
    .option("amount", {
        type: "number",
        description: "Reward amount (raw units); must respect on-chain max_reward_bps cap",
        required: true,
    })
    .option("reward_id", {
        type: "number",
        description: "Unique ID for the reward record",
        required: true,
    })
    .parseSync();

function selectProgram(pool: "prime" | "auto"): StakeProgram {
    if (pool === "auto") {
        return anchor.workspace.VaultStakeAuto as Program<VaultStakeAuto>;
    }
    return anchor.workspace.VaultStake as Program<VaultStake>;
}

async function main() {
    const fileEnv = loadEnvFile(args.env_file);
    const pool = args.pool as "prime" | "auto";

    let provider: AnchorProvider;
    if (args.use_local_validator_config) {
        const cfg = readLocalValidatorConfig(args.local_validator_config);
        const rpc =
            process.env.ANCHOR_PROVIDER_URL ||
            process.env.RPC_URL ||
            cfg.rpcUrl ||
            fileEnv.RPC_URL ||
            "http://127.0.0.1:8899";
        const kp = keypairFromConfigSecret(cfg.rewardsAdmin.secretKey);
        const connection = new Connection(rpc, "confirmed");
        provider = new AnchorProvider(
            connection,
            new Wallet(kp),
            {commitment: "confirmed", preflightCommitment: "confirmed"}
        );
    } else {
        provider = AnchorProvider.env();
    }
    anchor.setProvider(provider);

    const program = selectProgram(pool);

    const mintProgramStr = pickAddr(args.mint_program, "MINT_PROGRAM_ID", fileEnv);
    const stakeProgramStr =
        pool === "auto"
            ? pickAddr(args.stake_program, "STAKE_AUTO_PROGRAM_ID", fileEnv)
            : pickAddr(args.stake_program, "STAKE_PROGRAM_ID", fileEnv);
    const rewardsMintStr = pickAddr(args.rewards_mint, "MINT_TOKEN", fileEnv);
    const stakeMintStr =
        pool === "auto"
            ? pickAddr(args.mint, "STAKE_AUTO_TOKEN", fileEnv)
            : pickAddr(args.mint, "STAKE_TOKEN", fileEnv);
    const vaultAtaStr =
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
              );

    const mintProgramId = requireAddr("mint_program / MINT_PROGRAM_ID", mintProgramStr);
    const stakeProgramId = requireAddr(
        pool === "auto"
            ? "stake_program / STAKE_AUTO_PROGRAM_ID"
            : "stake_program / STAKE_PROGRAM_ID",
        stakeProgramStr
    );
    const rewardsMint = requireAddr("rewards_mint / MINT_TOKEN", rewardsMintStr);
    const mint = requireAddr(
        pool === "auto" ? "mint / STAKE_AUTO_TOKEN" : "mint / STAKE_TOKEN",
        stakeMintStr
    );
    const vaultTokenAccount = requireAddr(
        pool === "auto"
            ? "vault_token_account / STAKE_AUTO_VAULT_TOKEN_ACCOUNT"
            : "vault_token_account / STAKE_VAULT_TOKEN_ACCOUNT",
        vaultAtaStr
    );

    const signer = provider.wallet.publicKey;
    const thisProgramId = program.programId;
    if (!stakeProgramId.equals(thisProgramId)) {
        throw new Error(
            `stake_program (${stakeProgramId.toBase58()}) must match the workspace program for --pool ${pool} (${thisProgramId.toBase58()}). Fix .env or pass --stake_program.`
        );
    }

    const [stakeConfigPda] = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("stake_config")],
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

    const [stakeRewardConfigPda] = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("stake_reward_config"), stakeConfigPda.toBuffer()],
        thisProgramId
    );
    const [stakeRewardGuardConfigPda] = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("stake_reward_guard_config"), stakeConfigPda.toBuffer()],
        thisProgramId
    );

    const [vaultAuthorityPda] = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("vault_authority")],
        thisProgramId
    );

    const amount = new BN(args.amount);
    const rewardId = Number(args.reward_id);

    const [rewardsMintAuthorityPda] = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("mint_authority")],
        mintProgramId
    );

    const [mintConfigPda] = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("config")],
        mintProgramId
    );

    const [externalMintAuthorityPda] = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("external_mint_authority")],
        stakeProgramId
    );

    const [vaultMintAllowedExternalProgramsPda] =
        anchor.web3.PublicKey.findProgramAddressSync(
            [
                Buffer.from("allowed_external_mint_programs"),
                mintConfigPda.toBuffer(),
            ],
            mintProgramId
        );

    const [rewardsRecordPda] = anchor.web3.PublicKey.findProgramAddressSync(
        [
            Buffer.from("reward_record"),
            Buffer.from(new Uint32Array([rewardId]).buffer),
            Buffer.from(new BigUint64Array([createBigInt(amount.toString())]).buffer),
        ],
        thisProgramId
    );

    console.log("=== publish_rewards (localnet) ===\n");
    console.log("Pool:                        ", pool);
    console.log("Program ID (workspace):      ", thisProgramId.toBase58());
    console.log("Staking mint:                ", mint.toBase58());
    console.log("Rewards mint (e.g. wYLDS):   ", rewardsMint.toBase58());
    console.log("Amount:                      ", amount.toString());
    console.log("Reward ID:                   ", rewardId.toString());
    console.log("Mint program:                ", mintProgramId.toBase58());
    console.log("Stake program (env arg):     ", stakeProgramId.toBase58());
    console.log("Vault token account:         ", vaultTokenAccount.toBase58());
    console.log("Admin signer:                ", signer.toBase58());
    console.log();

    const tx = await program.methods
        .publishRewards(rewardId, amount)
        .accountsStrict({
            stakeConfig: stakeConfigPda,
            stakeVaultTokenAccountConfig: stakeVaultTokenAccountConfigPda,
            mintConfig: mintConfigPda,
            externalMintAuthority: externalMintAuthorityPda,
            mintProgram: mintProgramId,
            thisProgram: thisProgramId,
            vaultMintAllowedExternalPrograms: vaultMintAllowedExternalProgramsPda,
            admin: signer,
            rewardsMint: rewardsMint,
            rewardsMintAuthority: rewardsMintAuthorityPda,
            vaultTokenAccount: vaultTokenAccount,
            vaultAuthority: vaultAuthorityPda,
            mint: mint,
            rewardRecord: rewardsRecordPda,
            stakeRewardConfig: stakeRewardConfigPda,
            stakeRewardGuardConfig: stakeRewardGuardConfigPda,
            tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
            systemProgram: anchor.web3.SystemProgram.programId,
        })
        .rpc();

    console.log("Transaction:", tx);
}

main().catch(console.error);
