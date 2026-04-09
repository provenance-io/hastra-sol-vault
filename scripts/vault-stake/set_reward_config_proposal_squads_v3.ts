/**
 * set_reward_config_proposal_squads_v3.ts
 *
 * Creates a Squads v3 proposal for one or more StakeRewardConfig parameter updates
 * on vault-stake. Any provided flag is converted into an inner instruction and all
 * selected updates are batched into one proposal transaction.
 *
 * Usage:
 *   ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
 *   ANCHOR_WALLET=~/.config/solana/squad-member.json \
 *   yarn ts-node scripts/vault-stake/set_reward_config_proposal_squads_v3.ts \
 *     --multisig_pda <SQUADS_V3_MULTISIG_PDA> \
 *     --max_reward_bps 120 \
 *     --reward_period_seconds 3600
 */

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import BN from "bn.js";
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

const SQUADS_V3_PROGRAM_ID = new PublicKey(
    "SMPLecH534NA9acpos4G6x7uf3LWbCAwZQE9e8ZekMu"
);
const BPF_LOADER_UPGRADEABLE_ID = new PublicKey(
    "BPFLoaderUpgradeab1e11111111111111111111111"
);
const VAULT_AUTHORITY_INDEX = 1;

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

const args = yargs(process.argv.slice(2))
    .option("multisig_pda", {
        type: "string",
        description: "Squads v3 multisig account address",
        required: true,
    })
    .option("max_reward_bps", {
        type: "number",
        description: "Set max reward BPS (1..10000).",
    })
    .option("max_period_rewards", {
        type: "string",
        description: "Set absolute per-call rewards cap (raw token units).",
    })
    .option("reward_period_seconds", {
        type: "number",
        description: "Set cooldown in seconds between successful publish_rewards calls.",
    })
    .option("max_total_rewards", {
        type: "string",
        description: "Set lifetime cumulative rewards cap (raw token units).",
    })
    .check((argv) => {
        const hasAtLeastOne =
            argv.max_reward_bps !== undefined ||
            argv.max_period_rewards !== undefined ||
            argv.reward_period_seconds !== undefined ||
            argv.max_total_rewards !== undefined;
        if (!hasAtLeastOne) {
            throw new Error(
                "Provide at least one field to update: --max_reward_bps, --max_period_rewards, --reward_period_seconds, or --max_total_rewards"
            );
        }
        return true;
    })
    .parseSync();

const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);
const program = anchor.workspace.VaultStake as Program<VaultStake>;

async function main() {
    const msPda = new PublicKey(args.multisig_pda);
    const connection = provider.connection;
    const member = provider.wallet.payer;

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

    const authorityIndexBuf = Buffer.alloc(4);
    authorityIndexBuf.writeUInt32LE(VAULT_AUTHORITY_INDEX);
    const [vaultPda] = PublicKey.findProgramAddressSync(
        [
            Buffer.from("squad"),
            msPda.toBuffer(),
            authorityIndexBuf,
            Buffer.from("authority"),
        ],
        SQUADS_V3_PROGRAM_ID
    );

    const msAccountInfo = await connection.getAccountInfo(msPda);
    if (!msAccountInfo) throw new Error(`Multisig account not found: ${msPda.toBase58()}`);
    const currentTxIndex = msAccountInfo.data.readUInt32LE(12);
    const nextTxIndex = currentTxIndex + 1;

    const txIndexBuf = Buffer.alloc(4);
    txIndexBuf.writeUInt32LE(nextTxIndex);
    const [txPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("squad"), msPda.toBuffer(), txIndexBuf, Buffer.from("transaction")],
        SQUADS_V3_PROGRAM_ID
    );

    const adminAccounts = {
        stakeConfig: stakeConfigPda,
        stakeRewardConfig: stakeRewardConfigPda,
        signer: vaultPda,
        programData: programDataPda,
    };

    const innerInstructions: TransactionInstruction[] = [];
    const selected: string[] = [];

    if (args.max_reward_bps !== undefined) {
        const bps = Number(args.max_reward_bps);
        if (!Number.isFinite(bps) || bps <= 0 || bps > 10_000) {
            throw new Error(`max_reward_bps must be 1..10000, got ${args.max_reward_bps}`);
        }
        innerInstructions.push(
            await program.methods
                .updateMaxRewardBps(new BN(bps))
                .accountsStrict(adminAccounts)
                .instruction()
        );
        selected.push(`max_reward_bps=${bps}`);
    }

    if (args.max_period_rewards !== undefined) {
        const cap = new BN(args.max_period_rewards, 10);
        if (cap.lte(new BN(0))) {
            throw new Error(
                `max_period_rewards must be > 0, got ${args.max_period_rewards}`
            );
        }
        innerInstructions.push(
            await program.methods
                .updateMaxPeriodRewards(cap)
                .accountsStrict(adminAccounts)
                .instruction()
        );
        selected.push(`max_period_rewards=${cap.toString()}`);
    }

    if (args.reward_period_seconds !== undefined) {
        const seconds = new BN(args.reward_period_seconds);
        if (seconds.lte(new BN(0))) {
            throw new Error(
                `reward_period_seconds must be > 0, got ${args.reward_period_seconds}`
            );
        }
        innerInstructions.push(
            await program.methods
                .updateRewardPeriodSeconds(seconds)
                .accountsStrict(adminAccounts)
                .instruction()
        );
        selected.push(`reward_period_seconds=${seconds.toString()}`);
    }

    if (args.max_total_rewards !== undefined) {
        const cap = new BN(args.max_total_rewards, 10);
        if (cap.lte(new BN(0))) {
            throw new Error(
                `max_total_rewards must be > 0, got ${args.max_total_rewards}`
            );
        }
        innerInstructions.push(
            await program.methods
                .updateMaxTotalRewards(cap)
                .accountsStrict(adminAccounts)
                .instruction()
        );
        selected.push(`max_total_rewards=${cap.toString()}`);
    }

    console.log("=== set_reward_config Squads v3 Proposal (vault-stake) ===\n");
    console.log("Program ID:             ", program.programId.toBase58());
    console.log("Multisig PDA:           ", msPda.toBase58());
    console.log("Vault PDA (signer):     ", vaultPda.toBase58());
    console.log("StakeConfig PDA:        ", stakeConfigPda.toBase58());
    console.log("StakeRewardConfig PDA:  ", stakeRewardConfigPda.toBase58());
    console.log("Program Data PDA:       ", programDataPda.toBase58());
    console.log("Transaction PDA:        ", txPda.toBase58());
    console.log("Next tx index:          ", nextTxIndex);
    console.log("Updates:");
    selected.forEach((u) => console.log(`  - ${u}`));
    console.log();

    const createTxIx = new TransactionInstruction({
        programId: SQUADS_V3_PROGRAM_ID,
        keys: [
            { pubkey: msPda, isSigner: false, isWritable: true },
            { pubkey: txPda, isSigner: false, isWritable: true },
            { pubkey: member.publicKey, isSigner: true, isWritable: true },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data: Buffer.concat([DISC_CREATE_TRANSACTION, authorityIndexBuf]),
    });

    console.log("Submitting step 1/3: createTransaction...");
    const sig1 = await sendAndConfirmTransaction(connection, new Transaction().add(createTxIx), [member]);
    console.log(`  ✅ ${sig1}`);

    for (let i = 0; i < innerInstructions.length; i++) {
        const ixIndex = i + 1;
        const [ixPda] = PublicKey.findProgramAddressSync(
            [Buffer.from("squad"), txPda.toBuffer(), Buffer.from([ixIndex]), Buffer.from("instruction")],
            SQUADS_V3_PROGRAM_ID
        );
        const addIxIx = new TransactionInstruction({
            programId: SQUADS_V3_PROGRAM_ID,
            keys: [
                { pubkey: msPda, isSigner: false, isWritable: true },
                { pubkey: txPda, isSigner: false, isWritable: true },
                { pubkey: ixPda, isSigner: false, isWritable: true },
                { pubkey: member.publicKey, isSigner: true, isWritable: true },
                { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
            ],
            data: Buffer.concat([
                DISC_ADD_INSTRUCTION,
                serializeIncomingInstruction(innerInstructions[i]),
            ]),
        });

        console.log(`Submitting step 2/3.${ixIndex}: addInstruction...`);
        const sig = await sendAndConfirmTransaction(connection, new Transaction().add(addIxIx), [member]);
        console.log(`  ✅ ${sig}`);
    }

    const activateTxIx = new TransactionInstruction({
        programId: SQUADS_V3_PROGRAM_ID,
        keys: [
            { pubkey: msPda, isSigner: false, isWritable: true },
            { pubkey: txPda, isSigner: false, isWritable: true },
            { pubkey: member.publicKey, isSigner: true, isWritable: false },
        ],
        data: DISC_ACTIVATE_TRANSACTION,
    });

    console.log("Submitting step 3/3: activateTransaction...");
    const sig3 = await sendAndConfirmTransaction(connection, new Transaction().add(activateTxIx), [member]);
    console.log(`  ✅ ${sig3}`);

    console.log(`\n✅ Proposal #${nextTxIndex} created and activated`);
    console.log(`   Transaction PDA: ${txPda.toBase58()}`);
}

main().catch(console.error);

