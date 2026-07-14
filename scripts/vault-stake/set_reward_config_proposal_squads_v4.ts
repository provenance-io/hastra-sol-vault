/**
 * set_reward_config_proposal_squads_v4.ts
 *
 * Creates a Squads v4 proposal for one or more StakeRewardConfig parameter updates
 * on vault-stake. Any provided flag is converted into an inner instruction and all
 * selected updates are batched into a single vault transaction proposal.
 *
 * Usage:
 *   ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
 *   ANCHOR_WALLET=~/.config/solana/squad-member.json \
 *   yarn ts-node scripts/vault-stake/set_reward_config_proposal_squads_v4.ts \
 *     --multisig_pda <SQUADS_V4_MULTISIG_PDA> \
 *     --max_reward_bps 120 \
 *     --reward_period_seconds 3600
 */

import * as multisig from "@squads-protocol/multisig";
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import BN from "bn.js";
import {
    PublicKey,
    TransactionMessage,
    VersionedTransaction,
} from "@solana/web3.js";
import { VaultStake } from "../../target/types/vault_stake";
import yargs from "yargs";

const BPF_LOADER_UPGRADEABLE_ID = new PublicKey(
    "BPFLoaderUpgradeab1e11111111111111111111111"
);

const args = yargs(process.argv.slice(2))
    .option("multisig_pda", {
        type: "string",
        description: "Squads v4 multisig account address",
        required: true,
    })
    .option("program_id", {
        type: "string",
        description:
            "Optional vault-stake program id override. Use this to target devnet/prod deployments when local IDL address differs.",
    })
    .option("vault_index", {
        type: "number",
        description: "Squads vault index (default: 0)",
        default: 0,
    })
    .option("transaction_index", {
        type: "string",
        description:
            "Override the next transaction index read from the multisig account (u64 at byte offset 78).",
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
const workspaceProgram = anchor.workspace.VaultStake as Program<VaultStake>;

// Resolve program id deterministically from an explicit override when provided.
// This avoids accidentally targeting a local build id embedded in target/idl.
const resolvedIdl = JSON.parse(JSON.stringify(workspaceProgram.idl));
if (args.program_id) {
    // Validate key format eagerly to fail fast with a clear CLI error.
    new PublicKey(args.program_id);
    resolvedIdl.address = args.program_id;
    if (resolvedIdl.metadata) {
        resolvedIdl.metadata.address = args.program_id;
    }
}
const program = new anchor.Program(resolvedIdl as anchor.Idl, provider) as Program<VaultStake>;

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

    // Vault PDA — use SDK derivation with the specified vault index.
    const [vaultPda] = multisig.getVaultPda({ multisigPda: msPda, index: args.vault_index });

    // Transaction index — honour explicit override, fall back to reading the
    // Squads v4 multisig account data (u64 at byte offset 78).
    let transactionIndex: bigint;
    if (args.transaction_index !== undefined) {
        transactionIndex = BigInt(args.transaction_index);
    } else {
        const accountInfo = await connection.getAccountInfo(msPda);
        if (!accountInfo) throw new Error(`Multisig account not found: ${msPda.toBase58()}`);
        // Squads v4 stores transactionIndex as a u64 at byte offset 78 (needs 86+ bytes).
        // A v3 multisig account is much smaller and uses a u32 at offset 12 instead.
        const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";
        if (accountInfo.owner.toBase58() === SYSTEM_PROGRAM_ID) {
            throw new Error(
                `Account ${msPda.toBase58()} is owned by the System Program — this is not a multisig account. ` +
                `Verify you passed the correct Squads v4 multisig PDA (not a wallet or vault PDA).`
            );
        }
        if (accountInfo.data.length < 86) {
            const SQUADS_V3_PROGRAM_ID = "SMPLecH534NA9acpos4G6x7uf3LWbCAwZQE9e8ZekMu";
            const isV3 = accountInfo.owner.toBase58() === SQUADS_V3_PROGRAM_ID;
            throw new Error(
                `Account ${msPda.toBase58()} data is only ${accountInfo.data.length} bytes — ` +
                `too small for a Squads v4 multisig (owner: ${accountInfo.owner.toBase58()}). ` +
                (isV3
                    ? `This looks like a Squads v3 multisig — use the v3 script instead.`
                    : `Pass --transaction_index <N> to override the index manually.`)
            );
        }
        transactionIndex = accountInfo.data.readBigUInt64LE(78) + BigInt(1);
    }

    const adminAccounts = {
        stakeConfig: stakeConfigPda,
        stakeRewardConfig: stakeRewardConfigPda,
        signer: vaultPda,
        programData: programDataPda,
    };

    const innerInstructions: anchor.web3.TransactionInstruction[] = [];
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

    console.log("=== set_reward_config Squads v4 Proposal (vault-stake) ===\n");
    console.log("Program ID:             ", program.programId.toBase58());
    console.log("Multisig PDA:           ", msPda.toBase58());
    console.log("Vault PDA (signer):     ", vaultPda.toBase58());
    console.log("StakeConfig PDA:        ", stakeConfigPda.toBase58());
    console.log("StakeRewardConfig PDA:  ", stakeRewardConfigPda.toBase58());
    console.log("Program Data PDA:       ", programDataPda.toBase58());
    console.log("Proposal index:         ", transactionIndex.toString());
    console.log("Updates:");
    selected.forEach((u) => console.log(`  - ${u}`));
    console.log();

    // Inner TransactionMessage — all reward config updates are bundled into a
    // single vault transaction so they execute atomically in one proposal.
    const innerTxMessage = new TransactionMessage({
        payerKey: vaultPda,
        recentBlockhash: (await connection.getLatestBlockhash()).blockhash,
        instructions: innerInstructions,
    });

    // Create the vault transaction and proposal in a single outer versioned tx.
    const ix1 = multisig.instructions.vaultTransactionCreate({
        multisigPda: msPda,
        transactionIndex,
        creator: member.publicKey,
        vaultIndex: args.vault_index,
        ephemeralSigners: 0,
        transactionMessage: innerTxMessage,
    });

    const ix2 = multisig.instructions.proposalCreate({
        multisigPda: msPda,
        transactionIndex,
        creator: member.publicKey,
    });

    const { blockhash } = await connection.getLatestBlockhash();
    const tx = new VersionedTransaction(
        new TransactionMessage({
            payerKey: member.publicKey,
            recentBlockhash: blockhash,
            instructions: [ix1, ix2],
        }).compileToV0Message()
    );
    tx.sign([member]);

    const sig = await connection.sendTransaction(tx);

    console.log(`✅ Proposal #${transactionIndex} submitted`);
    console.log(`   Transaction: ${sig}`);
    console.log(`\n   Next steps:`);
    console.log(`   1. Squad members approve at https://app.squads.so`);
    console.log(`   2. Once the approval threshold is met, execute the proposal`);
}

main().catch(console.error);
