/**
 * migrate_stake_config_pda_proposal_squads_v3.ts
 *
 * Creates a Squads v3 proposal to call `update_reward_config`, which will realloc/migrate the
 * `stake_reward_config` PDA in-place if needed (via Anchor's `realloc` constraint).
 *
 * Supports both pools:
 * - prime = vault-stake
 * - auto  = vault-stake-auto
 *
 * Usage:
 *   ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
 *   ANCHOR_WALLET=~/.config/solana/squad-member.json \
 *   yarn ts-node scripts/migrate_stake_config_pda_proposal_squads_v3.ts \
 *     --pool prime \
 *     --multisig_pda <SQUADS_V3_MULTISIG_PDA>
 *     --max_reward_bps 75
 */

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import BN from "bn.js";
import {
    PublicKey,
    SystemProgram,
    Transaction,
    TransactionInstruction,
    sendAndConfirmTransaction,
} from "@solana/web3.js";
import yargs from "yargs";
import { createHash } from "crypto";
import { VaultStake } from "../target/types/vault_stake";
import { VaultStakeAuto } from "../target/types/vault_stake_auto";

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
    return Buffer.concat([
        programId,
        keysLenBuf,
        keysData,
        dataLenBuf,
        Buffer.from(ix.data),
    ]);
}

type StakeProgram = Program<VaultStake> | Program<VaultStakeAuto>;

function selectProgram(pool: "prime" | "auto"): StakeProgram {
    if (pool === "auto") {
        return anchor.workspace.VaultStakeAuto as Program<VaultStakeAuto>;
    }
    return anchor.workspace.VaultStake as Program<VaultStake>;
}

// ----------------------------------------------------------------------------
// CLI args
// ----------------------------------------------------------------------------

/** Defaults aligned with `StakeRewardConfig` in programs/{vault-stake,vault-stake-auto}/src/state.rs */
const DEFAULT_MAX_PERIOD_REWARDS = "1000000000000";
const DEFAULT_REWARD_PERIOD_SECONDS = 3540;
const DEFAULT_MAX_TOTAL_REWARDS = "10000000000000";

const args = yargs(process.argv.slice(2))
    .option("pool", {
        type: "string",
        choices: ["prime", "auto"],
        default: "prime",
        description: "prime = vault-stake; auto = vault-stake-auto",
    })
    .option("multisig_pda", {
        type: "string",
        description: "Squads v3 multisig account address",
        required: true,
    })
    .option("max_reward_bps", {
        type: "number",
        description: "max_reward_bps to set (1–10000; e.g. 75 = 0.75%)",
        required: true,
    })
    .option("max_period_rewards", {
        type: "string",
        description:
            "Used when on-chain max_period_rewards is still zero (raw token units). Default: 1e12.",
    })
    .option("reward_period_seconds", {
        type: "number",
        description:
            "Used when on-chain reward_period_seconds is still <= 0. Default: 3540.",
    })
    .option("max_total_rewards", {
        type: "string",
        description:
            "Used when on-chain max_total_rewards is still zero (raw token units). Default: 1e13.",
    })
    .parseSync();

async function main() {
    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);

    const pool = args.pool as "prime" | "auto";
    const program = selectProgram(pool);

    const msPDA = new PublicKey(args.multisig_pda);
    const connection = provider.connection;
    const member = provider.wallet.payer;

    const newBps = Number(args.max_reward_bps);
    if (!Number.isFinite(newBps) || newBps <= 0 || newBps > 10_000) {
        throw new Error(`max_reward_bps must be 1–10000, got ${args.max_reward_bps}`);
    }

    const maxPeriodRewardsStr = args.max_period_rewards ?? DEFAULT_MAX_PERIOD_REWARDS;
    const rewardPeriodSecondsNum =
        args.reward_period_seconds ?? DEFAULT_REWARD_PERIOD_SECONDS;
    const maxTotalRewardsStr = args.max_total_rewards ?? DEFAULT_MAX_TOTAL_REWARDS;

    const maxPeriodRewardsBn = new BN(maxPeriodRewardsStr, 10);
    const rewardPeriodSecondsBn = new BN(rewardPeriodSecondsNum);
    const maxTotalRewardsBn = new BN(maxTotalRewardsStr, 10);

    if (maxPeriodRewardsBn.lte(new BN(0))) {
        throw new Error(`max_period_rewards must be > 0, got ${maxPeriodRewardsStr}`);
    }
    if (rewardPeriodSecondsBn.lte(new BN(0))) {
        throw new Error(
            `reward_period_seconds must be > 0, got ${rewardPeriodSecondsNum}`
        );
    }
    if (maxTotalRewardsBn.lte(new BN(0))) {
        throw new Error(`max_total_rewards must be > 0, got ${maxTotalRewardsStr}`);
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
    if (!msAccountInfo) {
        throw new Error(`Multisig account not found: ${msPDA.toBase58()}`);
    }
    const currentTxIndex = msAccountInfo.data.readUInt32LE(12);
    const nextTxIndex = currentTxIndex + 1;

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
    const [ixPda] = PublicKey.findProgramAddressSync(
        [
            Buffer.from("squad"),
            txPda.toBuffer(),
            Buffer.from([1]),
            Buffer.from("instruction"),
        ],
        SQUADS_V3_PROGRAM_ID
    );

    // --- Print summary --------------------------------------------------------

    console.log("=== migrate_stake_config_pda Squads v3 Proposal ===\n");
    console.log("Pool:                 ", pool);
    console.log("Program ID:            ", program.programId.toBase58());
    console.log("Multisig PDA:          ", msPDA.toBase58());
    console.log("Vault PDA (signer):    ", vaultPda.toBase58());
    console.log("  ↑ verify this matches the on-chain upgrade authority");
    console.log("StakeConfig PDA:       ", stakeConfigPda.toBase58());
    console.log("StakeRewardConfig PDA: ", stakeRewardConfigPda.toBase58());
    console.log("Program Data:          ", programDataPda.toBase58());
    console.log("Transaction PDA:       ", txPda.toBase58());
    console.log("Next tx index:         ", nextTxIndex);
    console.log(`max_reward_bps:        ${newBps} (${(newBps / 100).toFixed(2)}%)`);
    console.log(`max_period_rewards:    ${maxPeriodRewardsBn.toString()}`);
    console.log(`reward_period_seconds: ${rewardPeriodSecondsBn.toString()}`);
    console.log(`max_total_rewards:     ${maxTotalRewardsBn.toString()}`);
    console.log();

    // --- Build inner update_reward_config instruction -------------------------

    const innerIx = await program.methods
        .updateRewardConfig(
            new BN(newBps),
            maxPeriodRewardsBn,
            rewardPeriodSecondsBn,
            maxTotalRewardsBn
        )
        .accountsStrict({
            stakeConfig: stakeConfigPda,
            stakeRewardConfig: stakeRewardConfigPda,
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
        data: Buffer.concat([
            DISC_ADD_INSTRUCTION,
            serializeIncomingInstruction(innerIx),
        ]),
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
    const sig1 = await sendAndConfirmTransaction(
        connection,
        new Transaction().add(createTxIx),
        [member]
    );
    console.log(`  ✅ ${sig1}`);

    console.log("Submitting step 2/3: addInstruction...");
    const sig2 = await sendAndConfirmTransaction(
        connection,
        new Transaction().add(addIxIx),
        [member]
    );
    console.log(`  ✅ ${sig2}`);

    console.log("Submitting step 3/3: activateTransaction...");
    const sig3 = await sendAndConfirmTransaction(
        connection,
        new Transaction().add(activateTxIx),
        [member]
    );
    console.log(`  ✅ ${sig3}`);

    console.log(`\n✅ Proposal #${nextTxIndex} created and activated`);
    console.log(`   Transaction PDA: ${txPda.toBase58()}`);
    console.log(`\n   Next steps:`);
    console.log(`   1. Squad members approve at https://devnet.squads.so`);
    console.log(`   2. Once threshold is met, execute the proposal`);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});

