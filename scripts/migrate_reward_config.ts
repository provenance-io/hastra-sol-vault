/**
 * migrate_reward_config.ts
 *
 * Calls `update_reward_config` to perform an in-place realloc migration of the
 * `stake_reward_config` PDA when the on-disk layout grows.
 *
 * This script supports both pools:
 * - prime = vault-stake
 * - auto  = vault-stake-auto
 *
 * Usage (example):
 *   ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
 *   ANCHOR_WALLET=~/.config/solana/id.json \
 *   yarn ts-node scripts/migrate_reward_config.ts --pool prime --max_reward_bps 75
 */

import * as anchor from "@coral-xyz/anchor";
import {AnchorProvider, Program} from "@coral-xyz/anchor";
import BN from "bn.js";
import {PublicKey, SystemProgram} from "@solana/web3.js";
import yargs from "yargs";
import {VaultStake} from "../target/types/vault_stake";
import {VaultStakeAuto} from "../target/types/vault_stake_auto";

type StakeProgram = Program<VaultStake> | Program<VaultStakeAuto>;

function selectProgram(pool: "prime" | "auto"): StakeProgram {
    if (pool === "auto") {
        return anchor.workspace.VaultStakeAuto as Program<VaultStakeAuto>;
    }
    return anchor.workspace.VaultStake as Program<VaultStake>;
}

const args = yargs(process.argv.slice(2))
    .option("pool", {
        type: "string",
        choices: ["prime", "auto"],
        default: "prime",
        description: "prime = vault-stake; auto = vault-stake-auto",
    })
    .option("max_reward_bps", {
        type: "number",
        description:
            "Value to set max_reward_bps to during migration (1–10000). Use the current on-chain value if you are migrating only.",
        required: true,
    })
    .parseSync();

async function main() {
    const provider = AnchorProvider.env();
    anchor.setProvider(provider);

    const pool = args.pool as "prime" | "auto";
    const program = selectProgram(pool);

    const maxRewardBps = Number(args.max_reward_bps);
    if (!Number.isFinite(maxRewardBps) || maxRewardBps <= 0 || maxRewardBps > 10_000) {
        throw new Error(`max_reward_bps must be 1–10000, got ${args.max_reward_bps}`);
    }

    const [stakeConfigPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("stake_config")],
        program.programId
    );
    const [stakeRewardConfigPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("stake_reward_config"), stakeConfigPda.toBuffer()],
        program.programId
    );

    const BPF_LOADER_UPGRADEABLE_ID = new PublicKey(
        "BPFLoaderUpgradeab1e11111111111111111111111"
    );
    const [programDataPda] = PublicKey.findProgramAddressSync(
        [program.programId.toBuffer()],
        BPF_LOADER_UPGRADEABLE_ID
    );

    const signer = provider.wallet.publicKey;

    console.log("=== migrate_reward_config ===\n");
    console.log("Pool:                 ", pool);
    console.log("Program ID:            ", program.programId.toBase58());
    console.log("StakeConfig PDA:       ", stakeConfigPda.toBase58());
    console.log("StakeRewardConfig PDA: ", stakeRewardConfigPda.toBase58());
    console.log("Program Data PDA:      ", programDataPda.toBase58());
    console.log("Signer:               ", signer.toBase58());
    console.log(`max_reward_bps:        ${maxRewardBps}`);
    console.log();

    const maxPeriodRewards = new BN("1000000000000");
    const rewardPeriodSeconds = new BN(3540);
    const maxTotalRewards = new BN("10000000000000");

    const sig = await program.methods
        .updateRewardConfig(
            new BN(maxRewardBps),
            maxPeriodRewards,
            rewardPeriodSeconds,
            maxTotalRewards
        )
        .accountsStrict({
            stakeConfig: stakeConfigPda,
            stakeRewardConfig: stakeRewardConfigPda,
            signer,
            programData: programDataPda,
            systemProgram: SystemProgram.programId,
        })
        .rpc({ commitment: "confirmed" });

    console.log("Signature:", sig);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});

