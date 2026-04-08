/**
 * Direct call to vault-stake-auto `initialize_price_config` (no Squads wrapper).
 *
 * Builds the same instruction as the inner tx in
 * initialize_price_config_proposal_squads_v3.ts, but with `signer` = ANCHOR_WALLET
 * (must be the program upgrade authority).
 *
 * Usage:
 *   ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
 *   ANCHOR_WALLET=~/.config/solana/upgrade-authority.json \
 *   yarn ts-node scripts/vault-stake-auto/initialize_price_config.ts \
 *     --chainlink_program <CHAINLINK_VERIFIER_PROGRAM_ID> \
 *     --chainlink_access_controller <ACCESS_CONTROLLER_ACCOUNT> \
 *     --feed_id <64_CHAR_HEX_FEED_ID> \
 *     --price_scale <SCALE> \
 *     --price_max_staleness <SECONDS>
 *
 * Optional:
 *   --chainlink_verifier <PUBKEY>  Override verifier state account (default: PDA ["verifier"] under chainlink_program)
 */

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import BN from "bn.js";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { VaultStakeAuto } from "../../target/types/vault_stake_auto";
import yargs from "yargs";

const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);

const program = anchor.workspace.VaultStakeAuto as Program<VaultStakeAuto>;

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
        description:
            "32-byte feed ID as a 64-character hex string (no 0x prefix)",
        required: true,
    })
    .option("price_scale", {
        type: "string",
        description:
            "Price scale factor matching Chainlink feed precision (e.g. 1000000000000000000 for 1e18)",
        required: true,
    })
    .option("price_max_staleness", {
        type: "number",
        description:
            "Maximum price staleness in seconds before deposit/redeem are rejected (e.g. 7200)",
        required: true,
    })
    .option("chainlink_verifier", {
        type: "string",
        description:
            'Override Chainlink verifier state account (default: PDA seeds ["verifier"] under chainlink_program — same as Squads v3 proposal script)',
        required: false,
    })
    .parseSync();

async function main() {
    const feedIdHex = args.feed_id.replace(/^0x/, "");
    if (feedIdHex.length !== 64) {
        throw new Error(
            `feed_id must be a 64-character hex string (32 bytes), got ${feedIdHex.length} characters`
        );
    }
    const feedIdBytes: number[] = Array.from(Buffer.from(feedIdHex, "hex"));

    const chainlinkProgramId = new PublicKey(args.chainlink_program);
    const [chainlinkVerifierDerived] = PublicKey.findProgramAddressSync(
        [Buffer.from("verifier")],
        chainlinkProgramId
    );
    const chainlinkVerifier = args.chainlink_verifier
        ? new PublicKey(args.chainlink_verifier)
        : chainlinkVerifierDerived;

    const [stakeConfigPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("stake_config")],
        program.programId
    );

    const [stakePriceConfigPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("stake_price_config"), stakeConfigPda.toBuffer()],
        program.programId
    );

    const [programData] = PublicKey.findProgramAddressSync(
        [program.programId.toBuffer()],
        BPF_LOADER_UPGRADEABLE_ID
    );

    const signer = provider.wallet.publicKey;

    console.log("=== initialize_price_config (vault-stake-auto) ===\n");
    console.log("Program ID:                  ", program.programId.toBase58());
    console.log("Signer (upgrade authority):  ", signer.toBase58());
    console.log("Stake Config PDA:            ", stakeConfigPda.toBase58());
    console.log("Stake Price Config PDA:      ", stakePriceConfigPda.toBase58());
    console.log("Program Data PDA:            ", programData.toBase58());
    console.log("Chainlink program:         ", args.chainlink_program);
    console.log("Chainlink verifier:          ", chainlinkVerifier.toBase58());
    if (!args.chainlink_verifier) {
        console.log("  (derived [verifier] PDA)   ");
    }
    console.log("Access controller:         ", args.chainlink_access_controller);
    console.log("Feed ID (hex):               ", feedIdHex);
    console.log("Price scale:                 ", args.price_scale);
    console.log("Max staleness (s):           ", args.price_max_staleness);
    console.log();

    const tx = await program.methods
        .initializePriceConfig(
            chainlinkProgramId,
            chainlinkVerifier,
            new PublicKey(args.chainlink_access_controller),
            feedIdBytes,
            new BN(args.price_scale),
            new BN(args.price_max_staleness)
        )
        .accountsStrict({
            stakeConfig: stakeConfigPda,
            stakePriceConfig: stakePriceConfigPda,
            signer: signer,
            programData: programData,
            systemProgram: SystemProgram.programId,
        })
        .rpc();

    console.log("✅ initialize_price_config succeeded");
    console.log("   Transaction:", tx);
    console.log("\n   Next: call verify_price with a signed Chainlink report (rewards admin).");
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
