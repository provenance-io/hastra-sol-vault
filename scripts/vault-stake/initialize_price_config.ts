/**
 * initialize_price_config.ts
 *
 * Directly invokes initializePriceConfig on vault-stake. The wallet must be
 * the current program upgrade authority, as the instruction validates it via
 * the programData account.
 *
 * Usage:
 *   ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
 *   ANCHOR_WALLET=~/.config/solana/upgrade-authority.json \
 *   yarn ts-node scripts/vault-stake/initialize_price_config.ts \
 *     --chainlink_program <CHAINLINK_VERIFIER_PROGRAM_ID> \
 *     --chainlink_access_controller <ACCESS_CONTROLLER_ACCOUNT> \
 *     --feed_id <64-char hex, no 0x prefix> \
 *     --price_scale <e.g. 1000000000000000000 for 1e18> \
 *     --price_max_staleness <seconds>
 */

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import BN from "bn.js";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { VaultStake } from "../../target/types/vault_stake";
import yargs from "yargs";

const BPF_LOADER_UPGRADEABLE_ID = new PublicKey(
    "BPFLoaderUpgradeab1e11111111111111111111111"
);

const args = yargs(process.argv.slice(2))
    .option("chainlink_program", {
        type: "string",
        description: "Chainlink verifier program ID",
        required: true,
    })
    .option("chainlink_access_controller", {
        type: "string",
        description: "Chainlink access controller account",
        required: true,
    })
    .option("feed_id", {
        type: "string",
        description: "32-byte feed ID as a 64-character hex string (no 0x prefix)",
        required: true,
    })
    .option("price_scale", {
        type: "string",
        description: "Price scale factor matching Chainlink feed precision (e.g. 1000000000000000000 for 1e18)",
        required: true,
    })
    .option("price_max_staleness", {
        type: "number",
        description: "Maximum price staleness in seconds before deposit/redeem are rejected (e.g. 300)",
        required: true,
    })
    .option("program_id", {
        type: "string",
        description: "Optional vault-stake program id override.",
    })
    .parseSync();

const provider = anchor.AnchorProvider.env();
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

async function main() {
    const feedIdHex = args.feed_id.replace(/^0x/, "");
    if (!/^[0-9a-fA-F]{64}$/.test(feedIdHex)) {
        throw new Error(
            `feed_id must be a 64-character hex string (32 bytes, no 0x prefix), got: ${args.feed_id}`
        );
    }

    const [stakeConfigPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("stake_config")],
        program.programId
    );
    const [stakePriceConfigPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("stake_price_config"), stakeConfigPda.toBuffer()],
        program.programId
    );
    const [programDataPda] = PublicKey.findProgramAddressSync(
        [program.programId.toBuffer()],
        BPF_LOADER_UPGRADEABLE_ID
    );

    const chainlinkProgramId = new PublicKey(args.chainlink_program);
    const [chainlinkVerifierPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("verifier")],
        chainlinkProgramId
    );
    const feedIdBytes: number[] = Array.from(Buffer.from(feedIdHex, "hex"));

    console.log("=== initialize_price_config (vault-stake) ===\n");
    console.log("Program ID:              ", program.programId.toBase58());
    console.log("Signer (upgrade auth):   ", provider.wallet.publicKey.toBase58());
    console.log("Stake Config PDA:        ", stakeConfigPda.toBase58());
    console.log("Stake Price Config PDA:  ", stakePriceConfigPda.toBase58());
    console.log("Program Data:            ", programDataPda.toBase58());
    console.log("Chainlink program:       ", args.chainlink_program);
    console.log("Chainlink verifier:      ", chainlinkVerifierPda.toBase58());
    console.log("Access controller:       ", args.chainlink_access_controller);
    console.log("Feed ID (hex):           ", feedIdHex);
    console.log("Price scale:             ", args.price_scale);
    console.log("Max staleness (s):       ", args.price_max_staleness);
    console.log();

    const tx = await program.methods
        .initializePriceConfig(
            chainlinkProgramId,
            chainlinkVerifierPda,
            new PublicKey(args.chainlink_access_controller),
            feedIdBytes,
            new BN(args.price_scale),
            new BN(args.price_max_staleness),
        )
        .accountsStrict({
            stakeConfig: stakeConfigPda,
            stakePriceConfig: stakePriceConfigPda,
            signer: provider.wallet.publicKey,
            programData: programDataPda,
            systemProgram: SystemProgram.programId,
        })
        .rpc()
        .catch((err) => {
            if (err.getLogs) {
                console.error("Program logs:", err.getLogs());
            }
            throw err;
        });

    console.log(`✅ initialize_price_config succeeded`);
    console.log(`   Transaction: ${tx}`);
}

main().catch(console.error);
