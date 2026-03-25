/**
 * update_reward_cap_proposal_squads_v3.ts
 *
 * Creates a Squads v3 transaction proposal to call update_max_reward_bps
 * on the vault-stake program. Requires the upgrade authority (Squads vault PDA)
 * to sign, so it must go through a multisig proposal.
 *
 * Squads v3 proposal lifecycle (3 separate transactions):
 *   1. createTransaction(multisig, authorityIndex=1)
 *   2. addInstruction(multisig, transaction, innerIx)
 *   3. activateTransaction(multisig, transaction)  ← moves to Active for voting
 *
 * After activation, squad members approve at https://devnet.squads.so.
 *
 * Usage:
 *   ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
 *   ANCHOR_WALLET=~/.config/solana/squad-member.json \
 *   yarn ts-node scripts/vault-stake/update_reward_cap_proposal_squads_v3.ts \
 *     --multisig_pda <SQUADS_V3_MULTISIG_PDA> \
 *     --max_reward_bps 75
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
import { VaultStake } from "../../target/types/vault_stake";
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

const VAULT_AUTHORITY_INDEX = 1;

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

function ixDiscriminator(name: string): Buffer {
    return Buffer.from(
        createHash("sha256").update(`global:${name}`).digest()
    ).subarray(0, 8);
}

const DISC_CREATE_TRANSACTION  = ixDiscriminator("create_transaction");
const DISC_ADD_INSTRUCTION     = ixDiscriminator("add_instruction");
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
    .option("max_reward_bps", {
        type: "number",
        description: "New max reward cap in basis points (e.g. 75 = 0.75%)",
        required: true,
    })
    .parseSync();

// ----------------------------------------------------------------------------
// Anchor provider / program
// ----------------------------------------------------------------------------

const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);
const program = anchor.workspace.VaultStake as Program<VaultStake>;

// ----------------------------------------------------------------------------
// Main
// ----------------------------------------------------------------------------

async function main() {
    const msPDA = new PublicKey(args.multisig_pda);
    const newBps = args.max_reward_bps;
    const connection = provider.connection;
    const member = provider.wallet.payer;

    if (newBps <= 0 || newBps > 10_000) {
        throw new Error(`max_reward_bps must be 1–10000, got ${newBps}`);
    }

    // --- PDAs -----------------------------------------------------------------

    const [stakeConfigPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("stake_config")],
        program.programId
    );

    const [stakeRewardConfigPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("stake_reward_config"), stakeConfigPda.toBuffer()],
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

    const msAccountInfo = await connection.getAccountInfo(msPDA);
    if (!msAccountInfo) throw new Error(`Multisig account not found: ${msPDA.toBase58()}`);
    const currentTxIndex = msAccountInfo.data.readUInt32LE(12);
    const nextTxIndex = currentTxIndex + 1;

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

    console.log("=== update_max_reward_bps Squads v3 Proposal ===\n");
    console.log("Program ID:             ", program.programId.toBase58());
    console.log("Multisig PDA:           ", msPDA.toBase58());
    console.log("Vault PDA (signer):     ", vaultPda.toBase58());
    console.log("  ↑ verify this matches the on-chain upgrade authority");
    console.log("StakeConfig PDA:        ", stakeConfigPda.toBase58());
    console.log("StakeRewardConfig PDA:  ", stakeRewardConfigPda.toBase58());
    console.log("Program Data:           ", programDataPda.toBase58());
    console.log("Transaction PDA:        ", txPda.toBase58());
    console.log("Next tx index:          ", nextTxIndex);
    console.log(`New max_reward_bps:      ${newBps} (${(newBps / 100).toFixed(2)}%)`);
    console.log();

    // --- Build inner update_max_reward_bps instruction ------------------------

    const innerIx = await program.methods
        .updateMaxRewardBps(new BN(newBps))
        .accountsStrict({
            stakeConfig: stakeConfigPda,
            stakeRewardConfig: stakeRewardConfigPda,
            signer: vaultPda,
            programData: programDataPda,
        })
        .instruction();

    // --- Squads v3 instructions -----------------------------------------------

    const authorityIndexDataBuf = Buffer.alloc(4);
    authorityIndexDataBuf.writeUInt32LE(VAULT_AUTHORITY_INDEX);

    const createTxIx = new TransactionInstruction({
        programId: SQUADS_V3_PROGRAM_ID,
        keys: [
            { pubkey: msPDA,               isSigner: false, isWritable: true },
            { pubkey: txPda,               isSigner: false, isWritable: true },
            { pubkey: member.publicKey,    isSigner: true,  isWritable: true },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data: Buffer.concat([DISC_CREATE_TRANSACTION, authorityIndexDataBuf]),
    });

    const addIxIx = new TransactionInstruction({
        programId: SQUADS_V3_PROGRAM_ID,
        keys: [
            { pubkey: msPDA,               isSigner: false, isWritable: true },
            { pubkey: txPda,               isSigner: false, isWritable: true },
            { pubkey: ixPda,               isSigner: false, isWritable: true },
            { pubkey: member.publicKey,    isSigner: true,  isWritable: true },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data: Buffer.concat([DISC_ADD_INSTRUCTION, serializeIncomingInstruction(innerIx)]),
    });

    const activateTxIx = new TransactionInstruction({
        programId: SQUADS_V3_PROGRAM_ID,
        keys: [
            { pubkey: msPDA,            isSigner: false, isWritable: true },
            { pubkey: txPda,            isSigner: false, isWritable: true },
            { pubkey: member.publicKey, isSigner: true,  isWritable: false },
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
    console.log(`   1. Squad members approve at https://devnet.squads.so`);
    console.log(`   2. Once threshold is met, execute the proposal`);
    console.log(`   3. Verify: yarn ts-node scripts/vault-stake/derive_stake_reward_config.ts`);
    console.log(`      then fetch the account to confirm max_reward_bps = ${newBps}`);
}

main().catch(console.error);
