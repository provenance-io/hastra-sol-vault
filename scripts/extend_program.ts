/**
 * extend_program.ts
 *
 * Extends a BPFLoaderUpgradeable program's data account by a given number of bytes.
 *
 * The `solana program extend` CLI command rejects if the caller's keypair is not the
 * upgrade authority. The on-chain ExtendProgram instruction only requires a PAYER —
 * no upgrade authority signature is needed. This script bypasses the CLI check by
 * constructing the instruction directly.
 *
 * Use this when the program data account is too small for a pending upgrade buffer:
 *
 *   ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
 *   ANCHOR_WALLET=~/.config/solana/id.json \
 *   yarn ts-node scripts/extend_program.ts \
 *     --program_id <PROGRAM_ID> \
 *     --additional_bytes <BYTES>
 *
 * After this succeeds, re-simulate the upgrade proposal in Squads — it should pass.
 */

import * as anchor from "@coral-xyz/anchor";
import {
    PublicKey,
    Transaction,
    TransactionInstruction,
    SystemProgram,
} from "@solana/web3.js";
import yargs from "yargs";

const BPF_LOADER_UPGRADEABLE = new PublicKey(
    "BPFLoaderUpgradeab1e11111111111111111111111"
);

const args = yargs(process.argv.slice(2))
    .option("program_id", {
        type: "string",
        description: "Address of the program to extend",
        required: true,
    })
    .option("additional_bytes", {
        type: "number",
        description: "Number of additional bytes to allocate in the programData account",
        required: true,
    })
    .parseSync();

async function main() {
    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);

    const programId = new PublicKey(args.program_id);
    const additionalBytes = args.additional_bytes;

    if (additionalBytes <= 0 || !Number.isInteger(additionalBytes)) {
        throw new Error(`additional_bytes must be a positive integer, got ${additionalBytes}`);
    }

    // Parse programData address from the on-chain program account.
    // BPF upgradeable program account layout (bincode):
    //   [0..4]  u32 LE  — UpgradeableLoaderState::Program variant index (= 2)
    //   [4..36] Pubkey  — programdata_address
    const programAccountInfo = await provider.connection.getAccountInfo(programId);
    if (!programAccountInfo) {
        throw new Error(`Program account ${programId.toBase58()} not found`);
    }
    const programDataAddress = new PublicKey(programAccountInfo.data.slice(4, 36));

    console.log("=== extend_program ===\n");
    console.log("Program ID:        ", programId.toBase58());
    console.log("ProgramData:       ", programDataAddress.toBase58());
    console.log("Additional bytes:  ", additionalBytes);
    console.log("Payer:             ", provider.wallet.publicKey.toBase58());
    console.log();

    // ExtendProgram instruction data (bincode-encoded UpgradeableLoaderInstruction):
    //   [0..4] u32 LE — variant index 6 (ExtendProgram)
    //   [4..8] u32 LE — additional_bytes
    const data = Buffer.alloc(8);
    data.writeUInt32LE(6, 0);
    data.writeUInt32LE(additionalBytes, 4);

    const ix = new TransactionInstruction({
        programId: BPF_LOADER_UPGRADEABLE,
        keys: [
            { pubkey: programDataAddress, isSigner: false, isWritable: true },
            { pubkey: programId,          isSigner: false, isWritable: true },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
            { pubkey: provider.wallet.publicKey, isSigner: true, isWritable: true },
        ],
        data,
    });

    const tx = await provider.sendAndConfirm(new Transaction().add(ix));

    console.log(`✅ Extended successfully`);
    console.log(`   Transaction: ${tx}`);
    console.log(`\n   Re-simulate your upgrade proposal in Squads — it should now pass.`);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
