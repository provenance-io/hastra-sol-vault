/**
 * set_reward_config.ts
 *
 * Unified admin script to update one or more StakeRewardConfig fields on vault-stake-auto.
 * Any provided flag is applied in sequence using the corresponding on-chain instruction.
 *
 * Usage:
 *   ANCHOR_PROVIDER_URL=http://127.0.0.1:8899 ANCHOR_WALLET=~/.config/solana/id.json \
 *   yarn ts-node scripts/vault-stake-auto/set_reward_config.ts \
 *     --max_reward_bps 120 \
 *     --max_period_rewards 1000000000000 \
 *     --reward_period_seconds 3600 \
 *     --max_total_rewards 10000000000000
 */

import * as anchor from "@coral-xyz/anchor";
import { AnchorProvider, Program } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import yargs from "yargs";
import { VaultStakeAuto } from "../../target/types/vault_stake_auto";

const BPF_LOADER_UPGRADEABLE_ID = new PublicKey(
    "BPFLoaderUpgradeab1e11111111111111111111111"
);

const args = yargs(process.argv.slice(2))
    .option("max_reward_bps", {
        type: "number",
        description: "Set max reward BPS (1..10000).",
    })
    .option("max_period_rewards", {
        type: "string",
        description: "Set absolute per-call rewards cap (raw token units).",
    })
    .option("reward_period_seconds", {
        type: "number",
        description: "Set cooldown in seconds between successful publish_rewards calls.",
    })
    .option("max_total_rewards", {
        type: "string",
        description: "Set lifetime cumulative rewards cap (raw token units).",
    })
    .check((argv) => {
        const hasAtLeastOne =
            argv.max_reward_bps !== undefined ||
            argv.max_period_rewards !== undefined ||
            argv.reward_period_seconds !== undefined ||
            argv.max_total_rewards !== undefined;
        if (!hasAtLeastOne) {
            throw new Error(
                "Provide at least one field to update: --max_reward_bps, --max_period_rewards, --reward_period_seconds, or --max_total_rewards"
            );
        }
        return true;
    })
    .parseSync();

async function main() {
    const provider = AnchorProvider.env();
    anchor.setProvider(provider);
    const program = anchor.workspace.VaultStakeAuto as Program<VaultStakeAuto>;

    const [stakeConfigPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("stake_config")],
        program.programId
    );
    const [stakeRewardConfigPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("stake_reward_config"), stakeConfigPda.toBuffer()],
        program.programId
    );
    const [programDataPda] = PublicKey.findProgramAddressSync(
        [program.programId.toBuffer()],
        BPF_LOADER_UPGRADEABLE_ID
    );

    const signer = provider.wallet.publicKey;
    const adminAccounts = {
        stakeConfig: stakeConfigPda,
        stakeRewardConfig: stakeRewardConfigPda,
        signer,
        programData: programDataPda,
    };

    console.log("=== set_reward_config (vault-stake-auto) ===\n");
    console.log("Program ID:            ", program.programId.toBase58());
    console.log("StakeConfig PDA:       ", stakeConfigPda.toBase58());
    console.log("StakeRewardConfig PDA: ", stakeRewardConfigPda.toBase58());
    console.log("Program Data PDA:      ", programDataPda.toBase58());
    console.log("Signer:                ", signer.toBase58());
    console.log();

    if (args.max_reward_bps !== undefined) {
        const bps = Number(args.max_reward_bps);
        if (!Number.isFinite(bps) || bps <= 0 || bps > 10_000) {
            throw new Error(`max_reward_bps must be 1..10000, got ${args.max_reward_bps}`);
        }
        const sig = await program.methods
            .updateMaxRewardBps(new BN(bps))
            .accountsStrict(adminAccounts)
            .rpc({ commitment: "confirmed" });
        console.log(`update_max_reward_bps(${bps}) -> ${sig}`);
    }

    if (args.max_period_rewards !== undefined) {
        const cap = new BN(args.max_period_rewards, 10);
        if (cap.lte(new BN(0))) {
            throw new Error(
                `max_period_rewards must be > 0, got ${args.max_period_rewards}`
            );
        }
        const sig = await program.methods
            .updateMaxPeriodRewards(cap)
            .accountsStrict(adminAccounts)
            .rpc({ commitment: "confirmed" });
        console.log(`update_max_period_rewards(${cap.toString()}) -> ${sig}`);
    }

    if (args.reward_period_seconds !== undefined) {
        const seconds = new BN(args.reward_period_seconds);
        if (seconds.lte(new BN(0))) {
            throw new Error(
                `reward_period_seconds must be > 0, got ${args.reward_period_seconds}`
            );
        }
        const sig = await program.methods
            .updateRewardPeriodSeconds(seconds)
            .accountsStrict(adminAccounts)
            .rpc({ commitment: "confirmed" });
        console.log(`update_reward_period_seconds(${seconds.toString()}) -> ${sig}`);
    }

    if (args.max_total_rewards !== undefined) {
        const cap = new BN(args.max_total_rewards, 10);
        if (cap.lte(new BN(0))) {
            throw new Error(
                `max_total_rewards must be > 0, got ${args.max_total_rewards}`
            );
        }
        const sig = await program.methods
            .updateMaxTotalRewards(cap)
            .accountsStrict(adminAccounts)
            .rpc({ commitment: "confirmed" });
        console.log(`update_max_total_rewards(${cap.toString()}) -> ${sig}`);
    }

    const cfg = await program.account.stakeRewardConfig.fetch(stakeRewardConfigPda);
    console.log("\nFinal StakeRewardConfig:");
    console.log(`  max_reward_bps:       ${cfg.maxRewardBps.toString()}`);
    console.log(`  max_period_rewards:   ${cfg.maxPeriodRewards.toString()}`);
    console.log(`  reward_period_seconds:${cfg.rewardPeriodSeconds.toString()}`);
    console.log(`  max_total_rewards:    ${cfg.maxTotalRewards.toString()}`);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});

