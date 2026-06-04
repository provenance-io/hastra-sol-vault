/**
 * update_external_mint_programs_limit_proposal_squads.ts
 *
 * Creates a Squads v4 (@squads-protocol/multisig) vault transaction proposal to call
 * updateExternalMintProgramsLimit on vault-mint. Uses vaultTransactionCreate + proposalCreate
 * in a single outer transaction (same pattern as register_allowed_external_mint_program_proposal_squads.ts).
 *
 * Usage:
 *   ANCHOR_PROVIDER_URL=https://api.mainnet-beta.solana.com \
 *   ANCHOR_WALLET=~/.config/solana/squad-member.json \
 *   yarn ts-node scripts/vault-mint/update_external_mint_programs_limit_proposal_squads.ts \
 *     --multisig_pda <SQUADS_V4_MULTISIG_PDA> \
 *     --max_programs <0-255>
 *
 * Optional:
 *   --program_id <PUBKEY>     vault-mint program id when it differs from the workspace IDL
 *   --vault_pda <PUBKEY>      override Squads vault PDA when upgrade authority ≠ vault index 0
 *   --vault_index <N>         vault index for derivation / vaultTransactionCreate (default 0)
 *   --transaction_index <N>   override next proposal index (otherwise read u64 LE @ offset 78 + 1)
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
    .option("max_programs", {
        type: "number",
        description: "Maximum number of allowed external mint programs (0-255)",
        required: true,
    })
    .option("program_id", {
        type: "string",
        description:
            "Optional vault-mint program id override (mainnet / devnet when local IDL address differs)",
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

// Resolve program id from an explicit override when provided (avoids wrong cluster id in target/idl).
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
) as Program<VaultMint>;

async function main() {
    const msPDA = new PublicKey(args.multisig_pda);
    const connection = provider.connection;
    const member = provider.wallet.payer;
    const maxPrograms = Number(args.max_programs);
    const vaultIndex = Number(args.vault_index);

    if (!Number.isInteger(maxPrograms) || maxPrograms < 0 || maxPrograms > 255) {
        throw new Error("--max_programs must be an integer in the range [0, 255]");
    }
    if (!Number.isInteger(vaultIndex) || vaultIndex < 0) {
        throw new Error("--vault_index must be a non-negative integer");
    }

    const [configPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("config")],
        program.programId
    );
    const [externalMintProgramsLimitConfigPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("external_mint_programs_limit"), configPda.toBuffer()],
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

    console.log("=== updateExternalMintProgramsLimit Squads Proposal (v4 SDK) ===\n");
    console.log("Vault Mint Program ID:                 ", program.programId.toBase58());
    console.log("Multisig PDA:                          ", msPDA.toBase58());
    console.log("Vault PDA (signer):                    ", vaultPda.toBase58());
    console.log("Vault index:                           ", vaultIndex);
    console.log("Config PDA:                            ", configPda.toBase58());
    console.log("ExternalMintProgramsLimitConfig PDA:   ", externalMintProgramsLimitConfigPda.toBase58());
    console.log("Program Data:                          ", programDataPda.toBase58());
    console.log("New allowed-program limit:             ", maxPrograms);
    console.log("Proposal index:                        ", transactionIndex.toString());
    console.log();

    const ix = await (program.methods as any)
        .updateExternalMintProgramsLimit(maxPrograms)
        .accountsStrict({
            config: configPda,
            externalMintProgramsLimitConfig: externalMintProgramsLimitConfigPda,
            signer: vaultPda,
            programData: programDataPda,
            systemProgram: SystemProgram.programId,
        })
        .instruction();

    const innerTxMessage = new TransactionMessage({
        payerKey: vaultPda,
        recentBlockhash: (await connection.getLatestBlockhash()).blockhash,
        instructions: [ix],
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
    console.log(`   3. Confirm the limit via fetch_config or a direct account read`);
}

main().catch(console.error);
