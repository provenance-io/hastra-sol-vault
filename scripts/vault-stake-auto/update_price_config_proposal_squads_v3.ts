/**
 * update_price_config_proposal_squads_v3.ts
 *
 * Creates a Squads v3 (SMPLecH534NA9acpos4G6x7uf3LWbCAwZQE9e8ZekMu) transaction
 * proposal to call update_price_config on the vault-stake-auto program.
 *
 * Use this script when the multisig is a Squads v3 multisig.  The standard
 * update_price_config_proposal.ts uses the Squads v4 SDK, which will
 * reject v3 multisig accounts with AccountOwnedByWrongProgram (error 0xbbf).
 *
 * Squads v3 proposal lifecycle (3 separate transactions):
 *   1. createTransaction(multisig, authorityIndex=1)
 *   2. addInstruction(multisig, transaction, innerIx)
 *   3. activateTransaction(multisig, transaction)   ← moves to Active for voting
 *
 * After activation, squad members approve at https://devnet.squads.so.
 *
 * Usage:
 *   ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
 *   ANCHOR_WALLET=~/.config/solana/squad-member.json \
 *   yarn ts-node scripts/vault-stake-auto/update_price_config_proposal_squads_v3.ts \
 *     --multisig_pda <SQUADS_V3_MULTISIG_PDA> \
 *     --chainlink_program <CHAINLINK_VERIFIER_PROGRAM_ID> \
 *     --chainlink_access_controller <ACCESS_CONTROLLER_ACCOUNT> \
 *     --feed_id <64_CHAR_HEX_FEED_ID> \
 *     --price_scale <SCALE> \
 *     --price_max_staleness <SECONDS>
 */

import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import {
    PublicKey,
    SystemProgram,
    TransactionInstruction,
    Transaction,
    sendAndConfirmTransaction,
} from "@solana/web3.js";
import { VaultStakeAuto } from "../../target/types/vault_stake_auto";
import yargs from "yargs";
import { createHash } from "crypto";

// ----------------------------------------------------------------------------
// Constants
// ----------------------------------------------------------------------------

const SQUADS_V3_PROGRAM_ID = new PublicKey(
    "SMPLecH534NA9acpos4G6x7uf3LWbCAwZQE9e8ZekMu"
);

const BPF_LOADER_UPGRADEABLE_ID = new PublicKey(
    "BPFLoaderUpgradeab1e11111111111111111111111"
);

// Squads v3 vault authority index for external instructions (program upgrades, etc.)
const VAULT_AUTHORITY_INDEX = 1;

// ----------------------------------------------------------------------------
// Anchor discriminator helpers
// ----------------------------------------------------------------------------

/**
 * Compute the 8-byte Anchor instruction discriminator: sha256("global:<name>")[0..8]
 */
function ixDiscriminator(name: string): Buffer {
    return Buffer.from(
        createHash("sha256").update(`global:${name}`).digest()
    ).subarray(0, 8);
}

const DISC_CREATE_TRANSACTION = ixDiscriminator("create_transaction");
const DISC_ADD_INSTRUCTION = ixDiscriminator("add_instruction");
const DISC_ACTIVATE_TRANSACTION = ixDiscriminator("activate_transaction");

// ----------------------------------------------------------------------------
// Borsh serialization for IncomingInstruction
// ----------------------------------------------------------------------------

/**
 * Borsh-serialize an IncomingInstruction for the Squads v3 addInstruction call.
 *
 * Layout (all little-endian where applicable):
 *   program_id: Pubkey (32 bytes)
 *   keys: Vec<MsAccountMeta>
 *     len: u32 (4 bytes)
 *     each: pubkey (32 bytes) + is_signer (u8) + is_writable (u8)
 *   data: Vec<u8>
 *     len: u32 (4 bytes)
 *     bytes: data.length bytes
 */
function serializeIncomingInstruction(ix: TransactionInstruction): Buffer {
    const programId = ix.programId.toBuffer();

    const keysLenBuf = Buffer.alloc(4);
    keysLenBuf.writeUInt32LE(ix.keys.length);
    const keysData = Buffer.concat(
        ix.keys.map((k) =>
            Buffer.concat([
                k.pubkey.toBuffer(),
                Buffer.from([k.isSigner ? 1 : 0]),
                Buffer.from([k.isWritable ? 1 : 0]),
            ])
        )
    );

    const dataLenBuf = Buffer.alloc(4);
    dataLenBuf.writeUInt32LE(ix.data.length);

    return Buffer.concat([
        programId,
        keysLenBuf,
        keysData,
        dataLenBuf,
        Buffer.from(ix.data),
    ]);
}

// ----------------------------------------------------------------------------
// CLI args
// ----------------------------------------------------------------------------

const args = yargs(process.argv.slice(2))
    .option("multisig_pda", {
        type: "string",
        description: "Squads v3 multisig account address (owner: SMPLecH...)",
        required: true,
    })
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
    .parseSync();

// ----------------------------------------------------------------------------
// Anchor provider / program
// ----------------------------------------------------------------------------

const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);
const program = anchor.workspace.VaultStakeAuto as Program<VaultStakeAuto>;

// ----------------------------------------------------------------------------
// Main
// ----------------------------------------------------------------------------

async function main() {
    const msPDA = new PublicKey(args.multisig_pda);
    const connection = provider.connection;
    const member = provider.wallet.payer;

    // --- vault-stake-auto PDAs --------------------------------------------------

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

    // --- Feed ID ----------------------------------------------------------------

    const feedIdHex = args.feed_id.replace(/^0x/, "");
    if (feedIdHex.length !== 64) {
        throw new Error(
            `feed_id must be a 64-character hex string (32 bytes), got ${feedIdHex.length} characters`
        );
    }
    const feedIdBytes: number[] = Array.from(Buffer.from(feedIdHex, "hex"));

    // Derive the Chainlink verifier PDA: seeds = ["verifier", feed_id_bytes]
    const chainlinkProgramId = new PublicKey(args.chainlink_program);
    const [chainlinkVerifierPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("verifier")],
        chainlinkProgramId
    );

    // --- Squads v3 vault PDA (authority index 1) --------------------------------
    //
    // seeds: [b"squad", multisig, u32_le(authority_index), b"authority"]

    const authorityIndexBuf = Buffer.alloc(4);
    authorityIndexBuf.writeUInt32LE(VAULT_AUTHORITY_INDEX);

    const [vaultPda] = PublicKey.findProgramAddressSync(
        [
            Buffer.from("squad"),
            msPDA.toBuffer(),
            authorityIndexBuf,
            Buffer.from("authority"),
        ],
        SQUADS_V3_PROGRAM_ID
    );

    // --- Next transaction index (u32 LE at byte offset 12 of v3 Ms account) ----
    //
    // Squads v3 Ms account layout (after 8-byte Anchor discriminator):
    //   threshold:         u16  (2 bytes) @ offset  8
    //   authority_index:   u16  (2 bytes) @ offset 10
    //   transaction_index: u32  (4 bytes) @ offset 12  ← read this

    const msAccountInfo = await connection.getAccountInfo(msPDA);
    if (!msAccountInfo) {
        throw new Error(`Multisig account not found: ${msPDA.toBase58()}`);
    }
    const currentTxIndex = msAccountInfo.data.readUInt32LE(12);
    const nextTxIndex = currentTxIndex + 1;

    // --- Squads v3 transaction PDA ---------------------------------------------
    // seeds: [b"squad", multisig, u32_le(transaction_index), b"transaction"]

    const txIndexBuf = Buffer.alloc(4);
    txIndexBuf.writeUInt32LE(nextTxIndex);

    const [txPda] = PublicKey.findProgramAddressSync(
        [
            Buffer.from("squad"),
            msPDA.toBuffer(),
            txIndexBuf,
            Buffer.from("transaction"),
        ],
        SQUADS_V3_PROGRAM_ID
    );

    // --- Squads v3 instruction PDA (first instruction = index 1) ---------------
    // seeds: [b"squad", transaction, u8(instruction_index), b"instruction"]
    // Note: seed is the *transaction* PDA (not multisig), and instruction_index is u8.

    const [ixPda] = PublicKey.findProgramAddressSync(
        [
            Buffer.from("squad"),
            txPda.toBuffer(),            // transaction account, not multisig
            Buffer.from([1]),            // instruction index 1 (u8, 1-based)
            Buffer.from("instruction"),
        ],
        SQUADS_V3_PROGRAM_ID
    );

    // --- Print summary ----------------------------------------------------------

    console.log("=== update_price_config Squads v3 Proposal ===\n");
    console.log("Program ID:              ", program.programId.toBase58());
    console.log("Multisig PDA:            ", msPDA.toBase58());
    console.log("Vault PDA (signer):      ", vaultPda.toBase58());
    console.log("  ↑ verify this matches the on-chain upgrade authority");
    console.log("Transaction PDA:         ", txPda.toBase58());
    console.log("Instruction PDA:         ", ixPda.toBase58());
    console.log("Stake Config PDA:        ", stakeConfigPda.toBase58());
    console.log("Stake Price Config PDA:  ", stakePriceConfigPda.toBase58());
    console.log("Program Data:            ", programData.toBase58());
    console.log("Next transaction index:  ", nextTxIndex);
    console.log("Chainlink program:       ", args.chainlink_program);
    console.log("Chainlink verifier:      ", chainlinkVerifierPda.toBase58());
    console.log("Access controller:       ", args.chainlink_access_controller);
    console.log("Feed ID (hex):           ", feedIdHex);
    console.log("Price scale:             ", args.price_scale);
    console.log("Max staleness (s):       ", args.price_max_staleness);
    console.log();

    // --- Build inner update_price_config instruction ----------------------------
    //
    // The vault PDA is the signer: Squads co-signs the inner instruction with
    // the vault PDA when the proposal executes, satisfying validate_program_update_authority.
    // Note: update_price_config modifies an existing account, so no systemProgram needed.

    const innerIx = await program.methods
        .updatePriceConfig(
            new PublicKey(args.chainlink_program),
            chainlinkVerifierPda,
            new PublicKey(args.chainlink_access_controller),
            feedIdBytes,
            new BN(args.price_scale),
            new BN(args.price_max_staleness)
        )
        .accountsStrict({
            stakeConfig: stakeConfigPda,
            stakePriceConfig: stakePriceConfigPda,
            signer: vaultPda,
            programData: programData,
        })
        .instruction();

    // --- Build Squads v3 instructions ------------------------------------------

    // Step 1: createTransaction(authority_index: u32)
    //   Accounts: multisig (mut), transaction (init/mut), creator (mut/signer), system_program
    const authorityIndexDataBuf = Buffer.alloc(4);
    authorityIndexDataBuf.writeUInt32LE(VAULT_AUTHORITY_INDEX);

    const createTxIx = new TransactionInstruction({
        programId: SQUADS_V3_PROGRAM_ID,
        keys: [
            { pubkey: msPDA, isSigner: false, isWritable: true },
            { pubkey: txPda, isSigner: false, isWritable: true },
            { pubkey: member.publicKey, isSigner: true, isWritable: true },
            {
                pubkey: SystemProgram.programId,
                isSigner: false,
                isWritable: false,
            },
        ],
        data: Buffer.concat([DISC_CREATE_TRANSACTION, authorityIndexDataBuf]),
    });

    // Step 2: addInstruction(incoming_instruction: IncomingInstruction)
    //   Accounts: multisig (mut), transaction (mut), instruction (init/mut), creator (mut/signer), system_program
    const serializedIx = serializeIncomingInstruction(innerIx);

    const addIxIx = new TransactionInstruction({
        programId: SQUADS_V3_PROGRAM_ID,
        keys: [
            { pubkey: msPDA, isSigner: false, isWritable: true },
            { pubkey: txPda, isSigner: false, isWritable: true },
            { pubkey: ixPda, isSigner: false, isWritable: true },
            { pubkey: member.publicKey, isSigner: true, isWritable: true },
            {
                pubkey: SystemProgram.programId,
                isSigner: false,
                isWritable: false,
            },
        ],
        data: Buffer.concat([DISC_ADD_INSTRUCTION, serializedIx]),
    });

    // Step 3: activateTransaction()
    //   Accounts: multisig (mut), transaction (mut), creator (signer)
    const activateTxIx = new TransactionInstruction({
        programId: SQUADS_V3_PROGRAM_ID,
        keys: [
            { pubkey: msPDA, isSigner: false, isWritable: true },
            { pubkey: txPda, isSigner: false, isWritable: true },
            { pubkey: member.publicKey, isSigner: true, isWritable: false },
        ],
        data: DISC_ACTIVATE_TRANSACTION,
    });

    // --- Submit 3 transactions -------------------------------------------------

    console.log("Submitting step 1/3: createTransaction...");
    const tx1 = new Transaction().add(createTxIx);
    const sig1 = await sendAndConfirmTransaction(connection, tx1, [member]);
    console.log(`  ✅ ${sig1}`);

    console.log("Submitting step 2/3: addInstruction...");
    const tx2 = new Transaction().add(addIxIx);
    const sig2 = await sendAndConfirmTransaction(connection, tx2, [member]);
    console.log(`  ✅ ${sig2}`);

    console.log("Submitting step 3/3: activateTransaction...");
    const tx3 = new Transaction().add(activateTxIx);
    const sig3 = await sendAndConfirmTransaction(connection, tx3, [member]);
    console.log(`  ✅ ${sig3}`);

    console.log(`\n✅ Proposal #${nextTxIndex} created and activated`);
    console.log(`   Transaction PDA: ${txPda.toBase58()}`);
    console.log(`\n   Next steps:`);
    console.log(
        `   1. Squad members approve at https://devnet.squads.so (open Squad FftEXg…)`
    );
    console.log(
        `   2. Once the approval threshold is met, execute the proposal`
    );
    console.log(
        `   3. If the feed ID changed, call verify_price to refresh the stored price`
    );
}

main().catch(console.error);
