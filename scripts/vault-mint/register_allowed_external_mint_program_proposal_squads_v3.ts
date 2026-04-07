/**
 * register_allowed_external_mint_program_proposal_squads_v3.ts
 *
 * Creates a Squads v3 transaction proposal to call registerAllowedExternalMintProgram
 * on the vault-mint program. Requires the upgrade authority (Squads vault PDA)
 * to sign, so it must go through a multisig proposal.
 *
 * Squads v3 proposal lifecycle (3 separate transactions):
 *   1. createTransaction(multisig, authorityIndex=1)
 *   2. addInstruction(multisig, transaction, innerIx)
 *   3. activateTransaction(multisig, transaction)  ← moves to Active for voting
 *
 * After activation, squad members approve at https://devnet.squads.so (or app.squads.so on mainnet).
 *
 * For Squads v4 multisigs (@squads-protocol/multisig), use
 * register_allowed_external_mint_program_proposal_squads.ts instead.
 *
 * On first registration, init_if_needed allocates the AllowedExternalMintPrograms PDA;
 * the vault PDA pays rent — ensure the Squads vault has enough SOL before executing.
 *
 * Usage:
 *   ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
 *   ANCHOR_WALLET=~/.config/solana/squad-member.json \
 *   yarn ts-node scripts/vault-mint/register_allowed_external_mint_program_proposal_squads_v3.ts \
 *     --multisig_pda <SQUADS_V3_MULTISIG_PDA> \
 *     --external_program <VAULT_STAKE_AUTO_PROGRAM_ID>
 *
 * --multisig_pda must be the Squads v3 *multisig* (squad) account, NOT the vault PDA used as
 * program upgrade authority. Example devnet: multisig FftEXgzqaJNm8A6ynAmyfixBpHZtEJNr22q4KvUydByB;
 * vault PDA ATAkatkGWPDNdhLmeqd1PPdG6h7af5kkmivisuqVvX3K is derived from that multisig and is
 * only the inner-instruction signer — passing the vault here causes buffer read errors.
 *
 * Optional: --transaction_index <N> — use N as the new proposal’s tx index (skip reading multisig data).
 */

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
    PublicKey,
    SystemProgram,
    TransactionInstruction,
    Transaction,
    sendAndConfirmTransaction,
} from "@solana/web3.js";
import { VaultMint } from "../../target/types/vault_mint";
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

/** Authority index for the program upgrade authority (vault) — must match on-chain setup. */
const VAULT_AUTHORITY_INDEX = 1;

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

function ixDiscriminator(name: string): Buffer {
    return Buffer.from(
        createHash("sha256").update(`global:${name}`).digest()
    ).subarray(0, 8);
}

const DISC_CREATE_TRANSACTION = ixDiscriminator("create_transaction");
const DISC_ADD_INSTRUCTION = ixDiscriminator("add_instruction");
const DISC_ACTIVATE_TRANSACTION = ixDiscriminator("activate_transaction");

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
    return Buffer.concat([programId, keysLenBuf, keysData, dataLenBuf, Buffer.from(ix.data)]);
}

// ----------------------------------------------------------------------------
// CLI args
// ----------------------------------------------------------------------------

const args = yargs(process.argv.slice(2))
    .option("multisig_pda", {
        type: "string",
        description: "Squads v3 multisig account address",
        required: true,
    })
    .option("external_program", {
        type: "string",
        description:
            "Program ID of the external staking program to authorize (e.g. vault-stake-auto)",
        required: true,
    })
    .option("transaction_index", {
        type: "number",
        description:
            "Override: transaction index for this proposal (must be current on-chain max + 1). If omitted, read from multisig account data at offset 12 (u32 LE).",
        required: false,
    })
    .parseSync();

// ----------------------------------------------------------------------------
// Anchor provider / program
// ----------------------------------------------------------------------------

const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);
const program = anchor.workspace.VaultMint as Program<VaultMint>;

// ----------------------------------------------------------------------------
// Main
// ----------------------------------------------------------------------------

async function main() {
    const msPDA = new PublicKey(args.multisig_pda);
    const externalProgram = new PublicKey(args.external_program);
    const connection = provider.connection;
    const member = provider.wallet.payer;

    // --- PDAs -----------------------------------------------------------------

    const [configPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("config")],
        program.programId
    );

    const [allowedExternalMintProgramsPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("allowed_external_mint_programs"), configPda.toBuffer()],
        program.programId
    );

    const [programDataPda] = PublicKey.findProgramAddressSync(
        [program.programId.toBuffer()],
        BPF_LOADER_UPGRADEABLE_ID
    );

    // --- Squads v3 vault PDA (authority = upgrade authority) ------------------

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

    // --- Next transaction index -----------------------------------------------
    // Squads v3 Ms account: after 8-byte Anchor discriminator, transaction_index is u32 LE @ offset 12.

    let nextTxIndex: number;
    if (args.transaction_index !== undefined) {
        nextTxIndex = args.transaction_index;
    } else {
        const msAccountInfo = await connection.getAccountInfo(msPDA);
        if (!msAccountInfo) {
            throw new Error(`Multisig account not found: ${msPDA.toBase58()}`);
        }
        const data = msAccountInfo.data;
        if (data.length < 16) {
            throw new Error(
                `Account ${msPDA.toBase58()} data length ${data.length} is too small for Squads v3 multisig layout ` +
                    `(need at least 16 bytes to read transaction_index at offset 12). ` +
                    `Did you pass the *vault* PDA (upgrade authority) instead of the *multisig* squad account? ` +
                    `Devnet example: multisig FftEXgzqaJNm8A6ynAmyfixBpHZtEJNr22q4KvUydByB — not ATAkatkGWPDNdhLmeqd1PPdG6h7af5kkmivisuqVvX3K. ` +
                    `Or pass --transaction_index explicitly.`
            );
        }
        const currentTxIndex = data.readUInt32LE(12);
        nextTxIndex = currentTxIndex + 1;
    }

    const txIndexBuf = Buffer.alloc(4);
    txIndexBuf.writeUInt32LE(nextTxIndex);

    const [txPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("squad"), msPDA.toBuffer(), txIndexBuf, Buffer.from("transaction")],
        SQUADS_V3_PROGRAM_ID
    );

    const [ixPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("squad"), txPda.toBuffer(), Buffer.from([1]), Buffer.from("instruction")],
        SQUADS_V3_PROGRAM_ID
    );

    // --- Print summary --------------------------------------------------------

    console.log("=== registerAllowedExternalMintProgram Squads v3 Proposal ===\n");
    console.log("Vault Mint Program ID:                  ", program.programId.toBase58());
    console.log("Multisig PDA:                           ", msPDA.toBase58());
    console.log("Vault PDA (signer):                     ", vaultPda.toBase58());
    console.log("  ↑ verify this matches the on-chain upgrade authority");
    console.log("Config PDA:                             ", configPda.toBase58());
    console.log("AllowedExternalMintPrograms PDA:       ", allowedExternalMintProgramsPda.toBase58());
    console.log("External program to register:          ", externalProgram.toBase58());
    console.log("Program Data:                           ", programDataPda.toBase58());
    console.log("Transaction PDA:                        ", txPda.toBase58());
    console.log("Next tx index:                          ", nextTxIndex);
    console.log();

    // --- Build inner instruction ----------------------------------------------

    const innerIx = await program.methods
        .registerAllowedExternalMintProgram()
        .accountsStrict({
            config: configPda,
            allowedExternalMintPrograms: allowedExternalMintProgramsPda,
            externalProgram: externalProgram,
            signer: vaultPda,
            programData: programDataPda,
            systemProgram: SystemProgram.programId,
        })
        .instruction();

    // --- Squads v3 instructions -----------------------------------------------

    const authorityIndexDataBuf = Buffer.alloc(4);
    authorityIndexDataBuf.writeUInt32LE(VAULT_AUTHORITY_INDEX);

    const createTxIx = new TransactionInstruction({
        programId: SQUADS_V3_PROGRAM_ID,
        keys: [
            { pubkey: msPDA, isSigner: false, isWritable: true },
            { pubkey: txPda, isSigner: false, isWritable: true },
            { pubkey: member.publicKey, isSigner: true, isWritable: true },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data: Buffer.concat([DISC_CREATE_TRANSACTION, authorityIndexDataBuf]),
    });

    const addIxIx = new TransactionInstruction({
        programId: SQUADS_V3_PROGRAM_ID,
        keys: [
            { pubkey: msPDA, isSigner: false, isWritable: true },
            { pubkey: txPda, isSigner: false, isWritable: true },
            { pubkey: ixPda, isSigner: false, isWritable: true },
            { pubkey: member.publicKey, isSigner: true, isWritable: true },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data: Buffer.concat([DISC_ADD_INSTRUCTION, serializeIncomingInstruction(innerIx)]),
    });

    const activateTxIx = new TransactionInstruction({
        programId: SQUADS_V3_PROGRAM_ID,
        keys: [
            { pubkey: msPDA, isSigner: false, isWritable: true },
            { pubkey: txPda, isSigner: false, isWritable: true },
            { pubkey: member.publicKey, isSigner: true, isWritable: false },
        ],
        data: DISC_ACTIVATE_TRANSACTION,
    });

    // --- Submit ---------------------------------------------------------------

    console.log("Submitting step 1/3: createTransaction...");
    const sig1 = await sendAndConfirmTransaction(connection, new Transaction().add(createTxIx), [member]);
    console.log(`  ✅ ${sig1}`);

    console.log("Submitting step 2/3: addInstruction...");
    const sig2 = await sendAndConfirmTransaction(connection, new Transaction().add(addIxIx), [member]);
    console.log(`  ✅ ${sig2}`);

    console.log("Submitting step 3/3: activateTransaction...");
    const sig3 = await sendAndConfirmTransaction(connection, new Transaction().add(activateTxIx), [member]);
    console.log(`  ✅ ${sig3}`);

    console.log(`\n✅ Proposal #${nextTxIndex} created and activated`);
    console.log(`   Transaction PDA: ${txPda.toBase58()}`);
    console.log(`\n   Next steps:`);
    console.log(`   1. Squad members approve at https://devnet.squads.so (or app.squads.so on mainnet)`);
    console.log(`   2. Once threshold is met, execute the proposal`);
    console.log(`   3. Confirm ${externalProgram.toBase58()} is listed for external_program_mint CPI`);
}

main().catch(console.error);
