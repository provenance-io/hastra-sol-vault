/**
 * highest_epoch_index.ts
 *
 * Scans on-chain RewardsEpoch accounts and reports the maximum stored index.
 * Use the result (+ 1, or higher) as `--first_capped_epoch` for
 * initialize_epoch_caps.
 *
 * Usage:
 *   ANCHOR_PROVIDER_URL=https://api.mainnet-beta.solana.com \
 *   ANCHOR_WALLET=~/.config/solana/id.json \
 *   yarn ts-node scripts/vault-mint/highest_epoch_index.ts
 *
 * Optional: --program_id <PUBKEY>
 */

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { VaultMint } from "../../target/types/vault_mint";
import yargs from "yargs";

const args = yargs(process.argv.slice(2))
    .option("program_id", {
        type: "string",
        description: "Optional vault-mint program id override",
    })
    .parseSync();

async function main() {
    const provider = anchor.AnchorProvider.env();
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

    console.log("=== highest_epoch_index (vault-mint) ===\n");
    console.log("Program ID:", program.programId.toBase58());

    const epochs = await program.account.rewardsEpoch.all();
    if (epochs.length === 0) {
        console.log("\nNo RewardsEpoch accounts found.");
        console.log("Suggested --first_capped_epoch: 0");
        return;
    }

    const highest = epochs.reduce((max, e) => Math.max(max, Number(e.account.index)), 0);
    console.log("Epochs scanned:             ", epochs.length);
    console.log("Highest epoch index:        ", highest);
    console.log("\nSuggested --first_capped_epoch:", highest + 1);
    console.log(
        "(After init, create_rewards_epoch requires last_rewards_epoch.index + 1.)"
    );
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
