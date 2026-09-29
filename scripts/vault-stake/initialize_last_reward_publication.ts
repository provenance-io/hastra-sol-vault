/**
 * initialize_last_reward_publication.ts
 *
 * Calls `initialize_last_reward_publication` on vault-stake. Creates the
 * LastRewardPublication PDA with `start_id` as the floor for future publishes.
 * The connected wallet must be the program upgrade authority.
 *
 * Use this when the PDA does not exist yet (e.g. after upgrading a pool that
 * already has historical RewardPublicationRecord accounts). Fails if the account
 * already exists. Seed `--start_id` at or above the highest historical id
 * (see highest_reward_publication_id.ts); err high — ids skipped by a high init
 * floor stay unused, then publish_rewards requires each id to be greater than
 * the stored floor and within MAX_GAP of it. Seeding too low leaves a
 * reusable gap.
 *
 * Requires a program build that includes `initialize_last_reward_publication`
 * (run `anchor build` so target/idl and types are current).
 *
 * Usage:
 *   ANCHOR_PROVIDER_URL=https://api.mainnet-beta.solana.com \
 *   ANCHOR_WALLET=~/.config/solana/id.json \
 *   yarn ts-node scripts/vault-stake/initialize_last_reward_publication.ts \
 *     --start_id <N>
 *
 * Optional: --program_id <PUBKEY>
 */

import * as anchor from "@coral-xyz/anchor";
import { AnchorProvider, Program } from "@coral-xyz/anchor";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import yargs from "yargs";
import { VaultStake } from "../../target/types/vault_stake";

const args = yargs(process.argv.slice(2))
    .option("start_id", {
        type: "number",
        description:
            "Floor for future publish_rewards ids; must be >= highest historical publication id; next publish must be > start_id and within MAX_GAP",
        required: true,
    })
    .option("program_id", {
        type: "string",
        description: "Optional vault-stake program id override",
    })
    .parseSync();

async function main() {
    const provider = AnchorProvider.env();
    anchor.setProvider(provider);
    const workspaceProgram = anchor.workspace.VaultStake as Program<VaultStake>;
    const resolvedIdl = JSON.parse(JSON.stringify(workspaceProgram.idl));
    if (args.program_id) {
        new PublicKey(args.program_id);
        resolvedIdl.address = args.program_id;
        if (resolvedIdl.metadata) {
            resolvedIdl.metadata.address = args.program_id;
        }
    }
    const program = new anchor.Program(resolvedIdl as anchor.Idl, provider) as Program<VaultStake>;

    const startId = Number(args.start_id);
    if (!Number.isInteger(startId) || startId < 0) {
        throw new Error("--start_id must be a non-negative integer");
    }

    const [stakeConfigPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("stake_config")],
        program.programId
    );
    const [lastRewardPublicationPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("last_reward_publication"), stakeConfigPda.toBuffer()],
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

    console.log("=== initialize_last_reward_publication (vault-stake) ===\n");
    console.log("Program ID:                 ", program.programId.toBase58());
    console.log("StakeConfig PDA:            ", stakeConfigPda.toBase58());
    console.log("LastRewardPublication PDA:  ", lastRewardPublicationPda.toBase58());
    console.log("Program Data PDA:           ", programDataPda.toBase58());
    console.log("start_id:                   ", startId);
    console.log("Signer (must be upgrade authority):", signer.toBase58());
    console.log();

    const sig = await program.methods
        .initializeLastRewardPublication(startId)
        .accountsStrict({
            stakeConfig: stakeConfigPda,
            lastRewardPublication: lastRewardPublicationPda,
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
