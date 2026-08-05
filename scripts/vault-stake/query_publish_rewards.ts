/**
 * Pull the N most recent publish_rewards publications (RewardPublicationRecord PDAs).
 *
 * Each successful publish_rewards creates a RewardPublicationRecord and emits
 * RewardsPublished with the same id / amount. This script reads the durable
 * on-chain records so historical ids remain discoverable for START_ID floors.
 *
 * Usage:
 *   ANCHOR_PROVIDER_URL=$RPC_URL ANCHOR_WALLET=~/.config/solana/id.json \
 *     yarn ts-node scripts/vault-stake/query_publish_rewards.ts \
 *       --program_id $VS_PRIME --limit 20
 */
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { VaultStake } from "../../target/types/vault_stake";
import yargs from "yargs";

const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);

const workspaceProgram = anchor.workspace.VaultStake as Program<VaultStake>;

const args = yargs(process.argv.slice(2))
    .option("program_id", {
        type: "string",
        description: "Optional program id override (PRIME / AUTO / SMB deployment).",
    })
    .option("limit", {
        type: "number",
        description: "Number of publications to print (newest id first).",
        default: 10,
    })
    .option("sort", {
        choices: ["id", "published_at"] as const,
        description: "Sort key before applying --limit (descending).",
        default: "id" as const,
    })
    .parseSync();

function formatUnixTs(ts: number): string {
    if (ts === 0) return "0";
    return `${ts} (${new Date(ts * 1000).toISOString()})`;
}

async function main() {
    const resolvedIdl = JSON.parse(JSON.stringify(workspaceProgram.idl));
    if (args.program_id) {
        resolvedIdl.address = args.program_id;
        if (resolvedIdl.metadata) {
            resolvedIdl.metadata.address = args.program_id;
        }
    }
    const program = new anchor.Program(resolvedIdl as anchor.Idl, provider) as Program<VaultStake>;

    const limit = Math.max(0, Math.floor(args.limit));
    if (limit === 0) {
        throw new Error("--limit must be > 0");
    }

    console.log("Program ID:", program.programId.toBase58());
    console.log(`Fetching RewardPublicationRecord accounts (limit=${limit}, sort=${args.sort} desc)...`);

    const all = await program.account.rewardPublicationRecord.all();

    const rows = all.map(({ publicKey, account }) => ({
        id: account.id as number,
        amount: account.amount.toString(),
        publishedAt: account.publishedAt.toNumber(),
        bump: account.bump as number,
        pubkey: publicKey.toBase58(),
    }));

    rows.sort((a, b) => {
        if (args.sort === "published_at") {
            return b.publishedAt - a.publishedAt || b.id - a.id;
        }
        return b.id - a.id || b.publishedAt - a.publishedAt;
    });

    const selected = rows.slice(0, limit);

    console.log(`Found ${rows.length} publication(s); showing ${selected.length}.`);
    console.log("-".repeat(72));

    for (const r of selected) {
        // ID is the publication key used by LastRewardPublication / START_ID floors.
        console.log(`ID:            ${r.id}`);
        console.log(`Amount:        ${r.amount}`);
        console.log(`Published At:  ${formatUnixTs(r.publishedAt)}`);
        console.log(`Record PDA:    ${r.pubkey}`);
        console.log(`Bump:          ${r.bump}`);
        console.log("-".repeat(72));
    }

    if (rows.length > 0) {
        const highestId = rows.reduce((max, r) => Math.max(max, r.id), 0);
        console.log(`Highest ID:    ${highestId}`);
        console.log(`Suggested next publish --reward_id: ${highestId + 1}`);
        console.log(`(After LastRewardPublication init, START_ID / floor should be >= ${highestId})`);
    } else {
        console.log("No RewardPublicationRecord accounts found for this program.");
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
