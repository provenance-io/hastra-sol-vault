/**
 * initialize_last_rewards_epoch_proposal_squads.ts
 *
 * Squads v4 proposal to call `initialize_last_rewards_epoch` (creates
 * LastRewardsEpoch PDA with start_index). Use when the upgrade authority is a
 * Squads vault PDA and the account is new.
 *
 * Usage:
 *   ANCHOR_PROVIDER_URL=https://api.mainnet-beta.solana.com \
 *   ANCHOR_WALLET=~/.config/solana/squad-member.json \
 *   yarn ts-node scripts/vault-mint/initialize_last_rewards_epoch_proposal_squads.ts \
 *     --multisig_pda <SQUADS_V4_MULTISIG_PDA> \
 *     --start_index <N>
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
import { VaultMint } from "../../target/types/vault_mint";
import yargs from "yargs";

const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);

const workspaceProgram = anchor.workspace.VaultMint as Program<VaultMint>;

const BPF_LOADER_UPGRADEABLE_ID = new PublicKey(
    "BPFLoaderUpgradeab1e11111111111111111111111"
);

const args = yargs(process.argv.slice(2))
    .option("multisig_pda", {
        type: "string",
        description: "Squads v4 multisig account address",
        required: true,
    })
    .option("start_index", {
        type: "number",
        description:
            "Floor for future create_rewards_epoch indices; next create uses start_index + 1",
        required: true,
    })
    .option("program_id", {
        type: "string",
        description: "Optional vault-mint program id override",
    })
    .option("vault_pda", {
        type: "string",
        description: "Override Squads-derived vault PDA",
    })
    .option("vault_index", {
        type: "number",
        description: "Squads vault index used to derive the vault PDA (default 0)",
        default: 0,
    })
    .option("transaction_index", {
        type: "string",
        description: "Override next proposal index",
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
const program = new anchor.Program(resolvedIdl as anchor.Idl, provider) as Program<VaultMint>;

async function main() {
    const msPDA = new PublicKey(args.multisig_pda);
    const connection = provider.connection;
    const member = provider.wallet.payer;
    const vaultIndex = args.vault_index;
    const startIndex = Number(args.start_index);
    if (!Number.isInteger(startIndex) || startIndex < 0) {
        throw new Error("--start_index must be a non-negative integer");
    }

    const [configPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("config")],
        program.programId
    );
    const [epochCapsConfigPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("epoch_caps_config")],
        program.programId
    );
    const [lastRewardsEpochPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("last_rewards_epoch")],
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
        transactionIndex = accountInfo.data.readBigUInt64LE(78) + BigInt(1);
    }

    console.log("=== initialize_last_rewards_epoch Squads Proposal (v4 SDK) ===\n");
    console.log("Program ID:              ", program.programId.toBase58());
    console.log("Multisig PDA:            ", msPDA.toBase58());
    console.log("Vault PDA (signer):      ", vaultPda.toBase58());
    console.log("EpochCapsConfig PDA:     ", epochCapsConfigPda.toBase58());
    console.log("LastRewardsEpoch PDA:    ", lastRewardsEpochPda.toBase58());
    console.log("start_index:             ", startIndex);
    console.log("Proposal index:          ", transactionIndex.toString());
    console.log();

    const innerIx = await program.methods
        .initializeLastRewardsEpoch(new anchor.BN(startIndex))
        .accountsStrict({
            config: configPda,
            epochCapsConfig: epochCapsConfigPda,
            lastRewardsEpoch: lastRewardsEpochPda,
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

    console.log(`Proposal #${transactionIndex} submitted`);
    console.log(`   Transaction: ${sig}`);
}

main().catch(console.error);
