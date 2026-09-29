/**
 * set_reward_config_proposal_squads.ts
 *
 * Creates a Squads v4 (@squads-protocol/multisig) vault transaction proposal for one or more
 * StakeRewardConfig updates on vault-stake. Selected flags become inner instructions in one
 * batched proposal.
 *
 * Usage:
 *   ANCHOR_PROVIDER_URL=https://api.mainnet-beta.solana.com \
 *   ANCHOR_WALLET=~/.config/solana/squad-member.json \
 *   yarn ts-node scripts/vault-stake/set_reward_config_proposal_squads.ts \
 *     --multisig_pda <SQUADS_V4_MULTISIG_PDA> \
 *     --max_reward_bps 75 \
 *     --reward_period_seconds 3540
 *
 * Optional:
 *   --program_id <PUBKEY>       vault-stake program id when it differs from the workspace IDL
 *   --vault_pda <PUBKEY>        override Squads vault PDA when upgrade authority ≠ vault index 0
 *   --vault_index <N>           vault index for derivation / vaultTransactionCreate (default 0)
 *   --transaction_index <N>     override next proposal index (otherwise u64 LE @ offset 78 + 1)
 */

import * as multisig from "@squads-protocol/multisig";
import {
    PublicKey,
    SystemProgram,
    TransactionMessage,
    VersionedTransaction,
} from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import BN from "bn.js";
import { VaultStake } from "../../target/types/vault_stake";
import yargs from "yargs";

const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);

const workspaceProgram = anchor.workspace.VaultStake as Program<VaultStake>;

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
            "Optional vault-stake program id override (mainnet / devnet when local IDL address differs)",
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
    .option("vault_pda", {
        type: "string",
        description:
            "Override the Squads-derived vault PDA when the upgrade authority is not vault index 0",
    })
    .option("vault_index", {
        type: "number",
        description: "Vault index for getVaultPda and vaultTransactionCreate (default 0)",
        default: 0,
    })
    .option("transaction_index", {
        type: "string",
        description:
            "Override the next transaction index (must be current on-chain value + 1). If omitted, u64 LE @ offset 78 of the multisig account + 1",
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

const resolvedIdl = JSON.parse(JSON.stringify(workspaceProgram.idl));
if (args.program_id) {
    new PublicKey(args.program_id);
    resolvedIdl.address = args.program_id;
    if (resolvedIdl.metadata) {
        resolvedIdl.metadata.address = args.program_id;
    }
}
const program = new anchor.Program(
    resolvedIdl as anchor.Idl,
    provider
) as Program<VaultStake>;

async function main() {
    const msPDA = new PublicKey(args.multisig_pda);
    const connection = provider.connection;
    const member = provider.wallet.payer;
    const vaultIndex = Number(args.vault_index);

    if (!Number.isInteger(vaultIndex) || vaultIndex < 0) {
        throw new Error("--vault_index must be a non-negative integer");
    }

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

    const [vaultPdaDerived] = multisig.getVaultPda({
        multisigPda: msPDA,
        index: vaultIndex,
    });
    const vaultPda = args.vault_pda ? new PublicKey(args.vault_pda) : vaultPdaDerived;

    let transactionIndex: bigint;
    if (args.transaction_index !== undefined) {
        transactionIndex = BigInt(args.transaction_index);
    } else {
        const accountInfo = await connection.getAccountInfo(msPDA);
        if (!accountInfo) {
            throw new Error(`Multisig account not found: ${msPDA.toBase58()}`);
        }
        if (accountInfo.data.length < 86) {
            throw new Error(
                `Account ${msPDA.toBase58()} data length ${accountInfo.data.length} is too small to read ` +
                    `transaction index at offset 78 (u64 LE). Pass a Squads v4 multisig address or --transaction_index.`
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
            throw new Error(`max_period_rewards must be > 0, got ${args.max_period_rewards}`);
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
            throw new Error(`max_total_rewards must be > 0, got ${args.max_total_rewards}`);
        }
        innerInstructions.push(
            await program.methods
                .updateMaxTotalRewards(cap)
                .accountsStrict(adminAccounts)
                .instruction()
        );
        selected.push(`max_total_rewards=${cap.toString()}`);
    }

    console.log("=== set_reward_config Squads Proposal (v4 SDK, vault-stake) ===\n");
    console.log("Program ID:             ", program.programId.toBase58());
    console.log("Multisig PDA:           ", msPDA.toBase58());
    console.log("Vault PDA (signer):     ", vaultPda.toBase58());
    console.log("Vault index:            ", vaultIndex);
    console.log("StakeConfig PDA:        ", stakeConfigPda.toBase58());
    console.log("StakeRewardConfig PDA:  ", stakeRewardConfigPda.toBase58());
    console.log("Program Data PDA:       ", programDataPda.toBase58());
    console.log("Proposal index:         ", transactionIndex.toString());
    console.log("Updates:");
    selected.forEach((u) => console.log(`  - ${u}`));
    console.log();

    const innerTxMessage = new TransactionMessage({
        payerKey: vaultPda,
        recentBlockhash: (await connection.getLatestBlockhash()).blockhash,
        instructions: innerInstructions,
    });

    const ix1 = multisig.instructions.vaultTransactionCreate({
        multisigPda: msPDA,
        transactionIndex,
        creator: member.publicKey,
        vaultIndex,
        ephemeralSigners: 0,
        transactionMessage: innerTxMessage,
    });

    const ix2 = multisig.instructions.proposalCreate({
        multisigPda: msPDA,
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
