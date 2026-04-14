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
        description: "Optional program id override (use vault-stake script against stake-auto deployment).",
    })
    .parseSync();

// Label width matches the existing show_accounts_and_pdas output (~42 chars)
const PAD = 42;
const line = (label: string, value: string) =>
    console.log(`${(label + ":").padEnd(PAD)}${value}`);

async function main() {
    const resolvedIdl = JSON.parse(JSON.stringify(workspaceProgram.idl));
    if (args.program_id) {
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
    const [stakePriceConfigPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("stake_price_config"), stakeConfigPda.toBuffer()],
        program.programId
    );

    line("Price Config PDA", stakePriceConfigPda.toBase58());

    try {
        const cfg = await program.account.stakePriceConfig.fetch(stakePriceConfigPda);

        line("Chainlink Program",           cfg.chainlinkProgram.toBase58());
        line("Chainlink Verifier Account",  cfg.chainlinkVerifierAccount.toBase58());
        line("Chainlink Access Controller", cfg.chainlinkAccessController.toBase58());
        line("Feed ID",                     Buffer.from(cfg.feedId).toString("hex"));
        line("Price",                       cfg.price.toString());
        line("Price Scale",                 cfg.priceScale.toString());

        const ts = cfg.priceTimestamp.toNumber();
        const tsStr = ts === 0
            ? "0 (never set)"
            : `${ts} (${new Date(ts * 1000).toISOString()})`;
        line("Price Timestamp", tsStr);

        line("Price Max Staleness", `${cfg.priceMaxStaleness.toNumber()}s`);
    } catch {
        line("Status", "Not initialized");
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
