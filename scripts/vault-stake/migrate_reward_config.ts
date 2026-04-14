/**
 * migrate_reward_config.ts
 *
 * Calls `migrate_reward_config` on vault-stake with the connected wallet as signer.
 * The wallet must be the program upgrade authority (typical for localnet / direct ops).
 *
 * On-chain, `max_reward_bps` is always set from arguments. The other three values are
 * written only when the stored field is still zero (see processor). Use the dedicated
 * single-field instructions to change non-zero caps.
 *
 * Usage:
 *   ANCHOR_PROVIDER_URL=http://127.0.0.1:8899 ANCHOR_WALLET=~/.config/solana/id.json \
 *   yarn ts-node scripts/vault-stake/migrate_reward_config.ts --max_reward_bps 75
 */

import * as anchor from "@coral-xyz/anchor";
import { AnchorProvider, Program } from "@coral-xyz/anchor";
import BN from "bn.js";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import yargs from "yargs";
import { VaultStake } from "../../target/types/vault_stake";

/** Defaults aligned with `StakeRewardConfig` in programs/vault-stake/src/state.rs */
const DEFAULT_MAX_PERIOD_REWARDS = "1000000000000";
const DEFAULT_REWARD_PERIOD_SECONDS = 3540;
const DEFAULT_MAX_TOTAL_REWARDS = "10000000000000";

const args = yargs(process.argv.slice(2))
    .option("max_reward_bps", {
        type: "number",
        description: "max_reward_bps to set (1–10000)",
        required: true,
    })
    .option("max_period_rewards", {
        type: "string",
        description:
            "Used when on-chain max_period_rewards is still zero (raw token units). Default: 1e12.",
    })
    .option("reward_period_seconds", {
        type: "number",
        description:
            "Used when on-chain reward_period_seconds is still <= 0. Default: 3540.",
    })
    .option("max_total_rewards", {
        type: "string",
        description:
            "Used when on-chain max_total_rewards is still zero (raw token units). Default: 1e13.",
    })
    .option("program_id", {
        type: "string",
        description: "Optional program id override (use vault-stake script against stake-auto deployment).",
    })
    .parseSync();

async function main() {
    const provider = AnchorProvider.env();
    anchor.setProvider(provider);
    const workspaceProgram = anchor.workspace.VaultStake as Program<VaultStake>;
    const resolvedIdl = JSON.parse(JSON.stringify(workspaceProgram.idl));
    if (args.program_id) {
        resolvedIdl.address = args.program_id;
        if (resolvedIdl.metadata) {
            resolvedIdl.metadata.address = args.program_id;
        }
    }
    const program = new anchor.Program(resolvedIdl as anchor.Idl, provider) as Program<VaultStake>;

    const newBps = args.max_reward_bps;
    if (newBps <= 0 || newBps > 10_000) {
        throw new Error(`max_reward_bps must be 1–10000, got ${newBps}`);
    }

    const maxPeriodRewardsStr = args.max_period_rewards ?? DEFAULT_MAX_PERIOD_REWARDS;
    const rewardPeriodSecondsNum = args.reward_period_seconds ?? DEFAULT_REWARD_PERIOD_SECONDS;
    const maxTotalRewardsStr = args.max_total_rewards ?? DEFAULT_MAX_TOTAL_REWARDS;

    const maxPeriodRewardsBn = new BN(maxPeriodRewardsStr, 10);
    const rewardPeriodSecondsBn = new BN(rewardPeriodSecondsNum);
    const maxTotalRewardsBn = new BN(maxTotalRewardsStr, 10);

    if (maxPeriodRewardsBn.lte(new BN(0))) {
        throw new Error(`max_period_rewards must be > 0, got ${maxPeriodRewardsStr}`);
    }
    if (rewardPeriodSecondsBn.lte(new BN(0))) {
        throw new Error(`reward_period_seconds must be > 0, got ${rewardPeriodSecondsNum}`);
    }
    if (maxTotalRewardsBn.lte(new BN(0))) {
        throw new Error(`max_total_rewards must be > 0, got ${maxTotalRewardsStr}`);
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

    console.log("=== migrate_reward_config (vault-stake compatible) ===\n");
    console.log("Program ID:            ", program.programId.toBase58());
    console.log("StakeConfig PDA:       ", stakeConfigPda.toBase58());
    console.log("StakeRewardConfig PDA: ", stakeRewardConfigPda.toBase58());
    console.log("Program Data PDA:      ", programDataPda.toBase58());
    console.log("Signer:                ", signer.toBase58());
    console.log(`max_reward_bps:         ${newBps}`);
    console.log(`max_period_rewards:     ${maxPeriodRewardsBn.toString()}`);
    console.log(`reward_period_seconds:  ${rewardPeriodSecondsBn.toString()}`);
    console.log(`max_total_rewards:      ${maxTotalRewardsBn.toString()}`);
    console.log();

    const sig = await program.methods
        .migrateRewardConfig(
            new BN(newBps),
            maxPeriodRewardsBn,
            rewardPeriodSecondsBn,
            maxTotalRewardsBn
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
