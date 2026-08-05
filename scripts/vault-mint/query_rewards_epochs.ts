/**
 * Pull up to N RewardsEpoch accounts for vault-mint (newest index first).
 *
 * Each create_rewards_epoch call creates a RewardsEpoch PDA keyed by index and
 * stores the Merkle root / total allocation for that epoch.
 *
 * Usage:
 *   ANCHOR_PROVIDER_URL=$RPC_URL ANCHOR_WALLET=~/.config/solana/id.json \
 *     yarn ts-node scripts/vault-mint/query_rewards_epochs.ts \
 *       --limit 20
 */
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { VaultMint } from "../../target/types/vault_mint";
import { PublicKey } from "@solana/web3.js";
import yargs from "yargs";

const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);

const workspaceProgram = anchor.workspace.VaultMint as Program<VaultMint>;

const args = yargs(process.argv.slice(2))
    .option("program_id", {
        type: "string",
        description: "Optional program id override.",
    })
    .option("limit", {
        type: "number",
        description: "Number of epochs to print (newest index first).",
        default: 10,
    })
    .option("sort", {
        choices: ["index", "created_ts"] as const,
        description: "Sort key before applying --limit (descending).",
        default: "index" as const,
    })
    .parseSync();

function formatUnixTs(ts: number): string {
    if (ts === 0) return "0";
    return `${ts} (${new Date(ts * 1000).toISOString()})`;
}

function formatMerkleRoot(root: number[]): string {
    return Buffer.from(root).toString("hex");
}

async function main() {
    const resolvedIdl = JSON.parse(JSON.stringify(workspaceProgram.idl));
    if (args.program_id) {
        resolvedIdl.address = args.program_id;
        if (resolvedIdl.metadata) {
            resolvedIdl.metadata.address = args.program_id;
        }
    }
    const program = new anchor.Program(resolvedIdl as anchor.Idl, provider) as Program<VaultMint>;

    const limit = Math.max(0, Math.floor(args.limit));
    if (limit === 0) {
        throw new Error("--limit must be > 0");
    }

    console.log("Program ID:", program.programId.toBase58());
    console.log(`Fetching RewardsEpoch accounts (limit=${limit}, sort=${args.sort} desc)...`);

    const all = await program.account.rewardsEpoch.all();

    const rows = all.map(({ publicKey, account }) => {
        const index = account.index.toNumber();
        const [expectedPda] = PublicKey.findProgramAddressSync(
            [Buffer.from("epoch"), new anchor.BN(index).toArrayLike(Buffer, "le", 8)],
            program.programId
        );
        return {
            index,
            merkleRoot: formatMerkleRoot(account.merkleRoot as number[]),
            total: account.total.toString(),
            createdTs: account.createdTs.toNumber(),
            pubkey: publicKey.toBase58(),
            pdaMatches: publicKey.equals(expectedPda),
        };
    });

    rows.sort((a, b) => {
        if (args.sort === "created_ts") {
            return b.createdTs - a.createdTs || b.index - a.index;
        }
        return b.index - a.index || b.createdTs - a.createdTs;
    });

    const selected = rows.slice(0, limit);

    console.log(`Found ${rows.length} epoch(s); showing ${selected.length}.`);
    console.log("-".repeat(72));

    for (const r of selected) {
        console.log(`Index:         ${r.index}`);
        console.log(`Total:         ${r.total}`);
        console.log(`Created At:    ${formatUnixTs(r.createdTs)}`);
        console.log(`Merkle Root:   ${r.merkleRoot}`);
        console.log(`Epoch PDA:     ${r.pubkey}`);
        if (!r.pdaMatches) {
            console.log(`PDA Check:     WARNING — address does not match seeds ["epoch", index]`);
        }
        console.log("-".repeat(72));
    }

    if (rows.length > 0) {
        const highestIndex = rows.reduce((max, r) => Math.max(max, r.index), 0);
        console.log(`Highest index: ${highestIndex}`);
        console.log(`Suggested next create_rewards_epoch --epoch: ${highestIndex + 1}`);
    } else {
        console.log("No RewardsEpoch accounts found for this program.");
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
