/**
 * fetch_epoch_caps_config.ts
 *
 * Reads the on-chain EpochCapsConfig PDA and prints first_capped_epoch and
 * max_epoch_cap. Use after initialize_epoch_caps to confirm the immutable
 * boundary, or before create_rewards_epoch to check the current ceiling.
 *
 * Usage:
 *   ANCHOR_PROVIDER_URL=https://api.mainnet-beta.solana.com \
 *   ANCHOR_WALLET=~/.config/solana/id.json \
 *   yarn ts-node scripts/vault-mint/fetch_epoch_caps_config.ts
 *
 * Optional: --program_id <PUBKEY>
 */

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { VaultMint } from "../../target/types/vault_mint";
import yargs from "yargs";

const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);

const workspaceProgram = anchor.workspace.VaultMint as Program<VaultMint>;

const args = yargs(process.argv.slice(2))
    .option("program_id", {
        type: "string",
        description: "Optional vault-mint program id override",
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
    const program = new anchor.Program(resolvedIdl as anchor.Idl, provider) as Program<VaultMint>;

    const [epochCapsConfigPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("epoch_caps_config")],
        program.programId
    );

    line("Program ID (vault-mint)", program.programId.toBase58());
    line("EpochCapsConfig PDA", epochCapsConfigPda.toBase58());

    try {
        const cfg = await program.account.epochCapsConfig.fetch(epochCapsConfigPda);
        line("first_capped_epoch", cfg.firstCappedEpoch.toString());
        line("max_epoch_cap", cfg.maxEpochCap.toString());
        line("bump", String(cfg.bump));
    } catch {
        line("Status", "Not initialized");
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
