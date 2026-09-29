/**
 * initialize_last_rewards_epoch.ts
 *
 * Calls `initialize_last_rewards_epoch` on vault-mint. Creates the
 * LastRewardsEpoch PDA with `start_index` as the floor for future creates.
 * The connected wallet must be the program upgrade authority.
 *
 * Requires `epoch_caps_config` already initialized. Rejects a floor that would
 * deadlock create (`start_index + 1 < first_capped_epoch`). Must exist before
 * `create_rewards_epoch`. The next create must use `start_index + 1`, then
 * contiguous indices (`last.index + 1`).
 *
 * Usage:
 *   ANCHOR_PROVIDER_URL=https://api.mainnet-beta.solana.com \
 *   ANCHOR_WALLET=~/.config/solana/id.json \
 *   yarn ts-node scripts/vault-mint/initialize_last_rewards_epoch.ts \
 *     --start_index <N>
 *
 * Optional: --program_id <PUBKEY>
 */

import * as anchor from "@coral-xyz/anchor";
import { AnchorProvider, Program } from "@coral-xyz/anchor";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import yargs from "yargs";
import { VaultMint } from "../../target/types/vault_mint";

const args = yargs(process.argv.slice(2))
    .option("start_index", {
        type: "number",
        description:
            "Floor for future create_rewards_epoch indices; next create uses start_index + 1",
        required: true,
    })
    .option("program_id", {
        type: "string",
        description: "Optional vault-mint program id override",
    })
    .parseSync();

async function main() {
    const provider = AnchorProvider.env();
    anchor.setProvider(provider);
    const workspaceProgram = anchor.workspace.VaultMint as Program<VaultMint>;
    const resolvedIdl = JSON.parse(JSON.stringify(workspaceProgram.idl));
    if (args.program_id) {
        new PublicKey(args.program_id);
        resolvedIdl.address = args.program_id;
        if (resolvedIdl.metadata) {
            resolvedIdl.metadata.address = args.program_id;
        }
    }
    const program = new anchor.Program(resolvedIdl as anchor.Idl, provider) as Program<VaultMint>;

    const startIndex = Number(args.start_index);
    if (!Number.isInteger(startIndex) || startIndex < 0) {
        throw new Error("--start_index must be a non-negative integer");
    }

    const [configPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("config")],
        program.programId
    );
    const [epochCapsConfigPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("epoch_caps_config")],
        program.programId
    );
    const [lastRewardsEpochPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("last_rewards_epoch")],
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

    console.log("=== initialize_last_rewards_epoch (vault-mint) ===\n");
    console.log("Program ID:              ", program.programId.toBase58());
    console.log("Config PDA:              ", configPda.toBase58());
    console.log("EpochCapsConfig PDA:     ", epochCapsConfigPda.toBase58());
    console.log("LastRewardsEpoch PDA:    ", lastRewardsEpochPda.toBase58());
    console.log("Program Data PDA:        ", programDataPda.toBase58());
    console.log("start_index:             ", startIndex);
    console.log("Signer (must be upgrade authority):", signer.toBase58());
    console.log();

    const sig = await program.methods
        .initializeLastRewardsEpoch(new anchor.BN(startIndex))
        .accountsStrict({
            config: configPda,
            epochCapsConfig: epochCapsConfigPda,
            lastRewardsEpoch: lastRewardsEpochPda,
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
