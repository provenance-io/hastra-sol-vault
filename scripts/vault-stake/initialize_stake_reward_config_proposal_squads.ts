/**
 * initialize_stake_reward_config_proposal_squads.ts
 *
 * Squads v4 proposal to call `initialize_stake_reward_config` (creates StakeRewardConfig PDA
 * with defaults). Use when the upgrade authority is a Squads vault PDA and the account is new.
 *
 * Run `anchor build` after pulling the program so the IDL includes this instruction.
 *
 * Usage:
 *   ANCHOR_PROVIDER_URL=https://api.mainnet-beta.solana.com \
 *   ANCHOR_WALLET=~/.config/solana/squad-member.json \
 *   yarn ts-node scripts/vault-stake/initialize_stake_reward_config_proposal_squads.ts \
 *     --multisig_pda <SQUADS_V4_MULTISIG_PDA>
 *
 * Optional: --program_id, --vault_pda, --vault_index, --transaction_index
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
        description: "Optional vault-stake program id override",
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
                `Account ${msPDA.toBase58()} data too small to read transaction index at offset 78. ` +
                    `Use a v4 multisig or --transaction_index.`
            );
        }
        transactionIndex = accountInfo.data.readBigUInt64LE(78) + BigInt(1);
    }

    console.log("=== initialize_stake_reward_config Squads Proposal (v4 SDK) ===\n");
    console.log("Program ID:             ", program.programId.toBase58());
    console.log("Multisig PDA:           ", msPDA.toBase58());
    console.log("Vault PDA (signer):     ", vaultPda.toBase58());
    console.log("Vault index:            ", vaultIndex);
    console.log("StakeConfig PDA:        ", stakeConfigPda.toBase58());
    console.log("StakeRewardConfig PDA:  ", stakeRewardConfigPda.toBase58());
    console.log("Program Data:           ", programDataPda.toBase58());
    console.log("Proposal index:         ", transactionIndex.toString());
    console.log();

    const innerIx = await program.methods
        .initializeStakeRewardConfig()
        .accountsStrict({
            stakeConfig: stakeConfigPda,
            stakeRewardConfig: stakeRewardConfigPda,
            signer: vaultPda,
            programData: programDataPda,
            systemProgram: SystemProgram.programId,
        })
        .instruction();

    const innerTxMessage = new TransactionMessage({
        payerKey: vaultPda,
        recentBlockhash: (await connection.getLatestBlockhash()).blockhash,
        instructions: [innerIx],
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
    console.log(`\n   Next: approve and execute in Squads, then verify the PDA.`);
}

main().catch(console.error);
