/**
 * highest_reward_publication_id.ts
 *
 * Scans on-chain RewardPublicationRecord accounts for a vault-stake program and
 * reports the maximum stored `id`. Use the result (or higher) as `--start_id`
 * for initialize_last_reward_publication.
 *
 * Filters by account discriminator rather than deriving addresses, so it works
 * across both historical `(id, amount)` seeds and any transitional layouts.
 *
 * Usage:
 *   ANCHOR_PROVIDER_URL=https://api.mainnet-beta.solana.com \
 *   ANCHOR_WALLET=~/.config/solana/id.json \
 *   yarn ts-node scripts/vault-stake/highest_reward_publication_id.ts
 *
 * Optional: --program_id <PUBKEY>
 */

import * as anchor from "@coral-xyz/anchor";
import { AnchorProvider, Program } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import yargs from "yargs";
import { VaultStake } from "../../target/types/vault_stake";

const args = yargs(process.argv.slice(2))
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

    console.log("=== highest_reward_publication_id (vault-stake) ===\n");
    console.log("Program ID:", program.programId.toBase58());

    const records = await program.account.rewardPublicationRecord.all();
    if (records.length === 0) {
        console.log("\nNo RewardPublicationRecord accounts found.");
        console.log("Suggested --start_id: 0");
        return;
    }

    let maxId = 0;
    let maxPubkey: PublicKey | null = null;
    for (const { publicKey, account } of records) {
        if (account.id > maxId) {
            maxId = account.id;
            maxPubkey = publicKey;
        }
    }

    console.log("Records scanned:          ", records.length);
    console.log("Highest publication id:   ", maxId);
    if (maxPubkey) {
        console.log("Record PDA at max id:     ", maxPubkey.toBase58());
    }
    console.log("\nSuggested --start_id:     ", maxId);
    console.log(
        "(Err high if unsure — ids skipped by a high init floor stay unused; " +
            "after init, publish_rewards requires last.id + 1. Seeding too low leaves a reusable gap.)"
    );
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
