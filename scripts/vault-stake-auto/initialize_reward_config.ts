/**
 * initialize_reward_config.ts
 *
 * Calls `initialize_reward_config` on vault-stake-auto with the connected wallet as signer.
 * The wallet must be the program upgrade authority (typical for localnet / direct ops).
 *
 * Usage:
 *   ANCHOR_PROVIDER_URL=http://127.0.0.1:8899 ANCHOR_WALLET=~/.config/solana/id.json \
 *   yarn ts-node scripts/vault-stake-auto/initialize_reward_config.ts --max_reward_bps 75
 */

import * as anchor from "@coral-xyz/anchor";
import { AnchorProvider, Program } from "@coral-xyz/anchor";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import yargs from "yargs";
import BN from "bn.js";
import { VaultStakeAuto } from "../../target/types/vault_stake_auto";

const BPF_LOADER_UPGRADEABLE_ID = new PublicKey(
    "BPFLoaderUpgradeab1e11111111111111111111111"
);

const args = yargs(process.argv.slice(2))
    .option("max_reward_bps", {
        type: "number",
        description: "max_reward_bps to set (1–10000; e.g. 75 = 0.75%)",
        required: true,
    })
    .parseSync();

async function main() {
    const provider = AnchorProvider.env();
    anchor.setProvider(provider);
    const program = anchor.workspace.VaultStakeAuto as Program<VaultStakeAuto>;

    const newBps = Number(args.max_reward_bps);
    if (!Number.isFinite(newBps) || newBps <= 0 || newBps > 10_000) {
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
    const [programDataPda] = PublicKey.findProgramAddressSync(
        [program.programId.toBuffer()],
        BPF_LOADER_UPGRADEABLE_ID
    );

    const signer = provider.wallet.publicKey;

    console.log("=== initialize_reward_config (vault-stake-auto) ===\n");
    console.log("Program ID:            ", program.programId.toBase58());
    console.log("StakeConfig PDA:       ", stakeConfigPda.toBase58());
    console.log("StakeRewardConfig PDA: ", stakeRewardConfigPda.toBase58());
    console.log("Program Data PDA:      ", programDataPda.toBase58());
    console.log("Signer:                ", signer.toBase58());
    console.log(`max_reward_bps:         ${newBps} (${(newBps / 100).toFixed(2)}%)`);
    console.log();

    const sig = await program.methods
        .initializeRewardConfig(new BN(newBps))
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

