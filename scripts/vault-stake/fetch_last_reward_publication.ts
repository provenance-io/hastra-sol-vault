/**
 * fetch_last_reward_publication.ts
 *
 * Reads the on-chain LastRewardPublication PDA and prints the stored id floor.
 * Use after initialize_last_reward_publication to confirm --start_id, or before
 * publish_rewards to see the minimum exclusive next reward_id.
 *
 * Usage:
 *   ANCHOR_PROVIDER_URL=https://api.mainnet-beta.solana.com \
 *   ANCHOR_WALLET=~/.config/solana/id.json \
 *   yarn ts-node scripts/vault-stake/fetch_last_reward_publication.ts
 *
 * Optional: --program_id <PUBKEY>
 */

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { VaultStake } from "../../target/types/vault_stake";
import yargs from "yargs";

const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);

const workspaceProgram = anchor.workspace.VaultStake as Program<VaultStake>;

const args = yargs(process.argv.slice(2))
    .option("program_id", {
        type: "string",
        description: "Optional program id override (use against AUTO or SMB deployments)",
    })
    .parseSync();

const PAD = 42;
const line = (label: string, value: string) =>
    console.log(`${(label + ":").padEnd(PAD)}${value}`);

async function main() {
    const resolvedIdl = JSON.parse(JSON.stringify(workspaceProgram.idl));
    if (args.program_id) {
        new PublicKey(args.program_id);
        resolvedIdl.address = args.program_id;
        if (resolvedIdl.metadata) {
            resolvedIdl.metadata.address = args.program_id;
        }
    }
    const program = new anchor.Program(resolvedIdl as anchor.Idl, provider) as Program<VaultStake>;

    const [stakeConfigPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("stake_config")],
        program.programId
    );

    const [lastRewardPublicationPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("last_reward_publication"), stakeConfigPda.toBuffer()],
        program.programId
    );

    line("Program ID (vault-stake compatible)", program.programId.toBase58());
    line("StakeConfig PDA", stakeConfigPda.toBase58());
    line("LastRewardPublication PDA", lastRewardPublicationPda.toBase58());

    try {
        const cfg = await program.account.lastRewardPublication.fetch(lastRewardPublicationPda);
        line("id (floor)", String(cfg.id));
        line("next publish_rewards id must be >", String(cfg.id));
        line("bump", String(cfg.bump));
    } catch {
        line("Status", "Not initialized");
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
