import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { VaultStake } from "../../target/types/vault_stake";
import { compress } from "snappy";
import yargs from "yargs";

const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);

const program = anchor.workspace.VaultStake as Program<VaultStake>;

const args = yargs(process.argv.slice(2))
    .option("signed_report", {
        type: "string",
        description: "Hex-encoded signed Chainlink Data Streams report (with or without 0x prefix)",
        required: true,
    })
    .parseSync();

async function main() {
    // Derive PDAs
    const [stakeConfigPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("stake_config")],
        program.programId
    );

    const [stakePriceConfigPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("stake_price_config"), stakeConfigPda.toBuffer()],
        program.programId
    );

    // Fetch on-chain StakePriceConfig to get Chainlink program addresses.
    // This avoids the caller having to re-specify addresses that are already
    // stored in the config, and prevents mismatches.
    const priceConfig = await program.account.stakePriceConfig.fetch(stakePriceConfigPda);

    // Parse signed report from hex
    const reportHex = args.signed_report.replace(/^0x/, "");
    if (reportHex.length === 0 || reportHex.length % 2 !== 0) {
        throw new Error(`signed_report must be a non-empty even-length hex string, got length ${reportHex.length}`);
    }
    const signedReportBytes = Buffer.from(reportHex, "hex");
    if (signedReportBytes.length < 32) {
        throw new Error(`signed_report must be at least 32 bytes, got ${signedReportBytes.length}`);
    }

    // Derive the config account from report_context[0] = first 32 bytes of the signed report.
    // Mirrors the Chainlink verifier program logic:
    //   Pubkey::find_program_address(&[&report_context[0]], &ID)
    // Must use the raw (uncompressed) bytes as the PDA seed.
    const [chainlinkConfigAccount] = PublicKey.findProgramAddressSync(
        [signedReportBytes.slice(0, 32)],
        priceConfig.chainlinkProgram
    );

    // Snappy-compress the report before passing to the on-chain verifier.
    // The Chainlink verifier program decompresses as its very first step (snap::raw format).
    // PDA derivation above uses the raw uncompressed bytes as the seed — that is correct.
    const compressedReport = Buffer.from(await compress(signedReportBytes));

    console.log("=== verify_price ===\n");
    console.log("Program ID:                ", program.programId.toBase58());
    console.log("Signer (rewards admin):    ", provider.wallet.publicKey.toBase58());
    console.log("Stake Config PDA:          ", stakeConfigPda.toBase58());
    console.log("Stake Price Config PDA:    ", stakePriceConfigPda.toBase58());
    console.log("Chainlink Program:         ", priceConfig.chainlinkProgram.toBase58());
    console.log("Chainlink Verifier:        ", priceConfig.chainlinkVerifierAccount.toBase58());
    console.log("Access Controller:         ", priceConfig.chainlinkAccessController.toBase58());
    console.log("Chainlink Config Account:  ", chainlinkConfigAccount.toBase58());
    console.log("Signed report:             ", signedReportBytes.length, "bytes (uncompressed),",
        compressedReport.length, "bytes (compressed)");
    console.log("Compressed report:         ", compressedReport.length, "bytes (compressed)",
        "0x" + compressedReport.toString("hex"));
    console.log();

    const tx = await program.methods
        .verifyPrice(compressedReport)
        .accountsStrict({
            stakeConfig: stakeConfigPda,
            stakePriceConfig: stakePriceConfigPda,
            chainlinkVerifierAccount: priceConfig.chainlinkVerifierAccount,
            chainlinkAccessController: priceConfig.chainlinkAccessController,
            chainlinkConfigAccount: chainlinkConfigAccount,
            chainlinkProgram: priceConfig.chainlinkProgram,
            signer: provider.wallet.publicKey,
        })
        .rpc();

    console.log(`✅ verify_price succeeded`);
    console.log(`   Transaction: ${tx}`);
    console.log(`\n   StakePriceConfig.price and price_timestamp (observations_timestamp) have been updated.`);
}

main().catch((err) => {
    if (err.getLogs) {
        console.error("Program logs:", err.getLogs());
    }
    console.error(err);
    process.exit(1);
});
