/**
 * update_external_mint_programs_limit_proposal_squads_v4.ts
 *
 * Creates a Squads v4 vault transaction proposal to call updateExternalMintProgramsLimit
 * on the vault-mint program.
 *
 * Usage:
 *   ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
 *   ANCHOR_WALLET=~/.config/solana/squad-member.json \
 *   yarn ts-node scripts/vault-mint/update_external_mint_programs_limit_proposal_squads_v4.ts \
 *     --multisig_pda <SQUADS_V4_MULTISIG_PDA> \
 *     --max_programs <0-255>
 */

import * as multisig from "@squads-protocol/multisig";
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
    PublicKey,
    SystemProgram,
    TransactionMessage,
    VersionedTransaction,
} from "@solana/web3.js";
import { VaultMint } from "../../target/types/vault_mint";
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
    .option("max_programs", {
        type: "number",
        description: "Maximum number of allowed external mint programs (0-255)",
        required: true,
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
        required: false,
    })
    .parseSync();

const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);
const program = anchor.workspace.VaultMint as Program<VaultMint>;

async function main() {
    const msPda = new PublicKey(args.multisig_pda);
    const connection = provider.connection;
    const member = provider.wallet.payer;
    const maxPrograms = Number(args.max_programs);

    if (!Number.isInteger(maxPrograms) || maxPrograms < 0 || maxPrograms > 255) {
        throw new Error("--max_programs must be an integer in the range [0, 255]");
    }

    // --- PDAs -----------------------------------------------------------------

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

    // --- Print summary --------------------------------------------------------

    console.log("=== updateExternalMintProgramsLimit Squads v4 Proposal ===\n");
    console.log("Vault Mint Program ID:                 ", program.programId.toBase58());
    console.log("Multisig PDA:                          ", msPda.toBase58());
    console.log("Vault PDA (signer):                    ", vaultPda.toBase58());
    console.log("  ↑ verify this matches the on-chain upgrade authority");
    console.log("Config PDA:                            ", configPda.toBase58());
    console.log("ExternalMintProgramsLimitConfig PDA:   ", externalMintProgramsLimitConfigPda.toBase58());
    console.log("Program Data:                          ", programDataPda.toBase58());
    console.log("New allowed-program limit:             ", maxPrograms);
    console.log("Proposal index:                        ", transactionIndex.toString());
    console.log();

    // --- Build inner instruction -----------------------------------------------

    const innerIx = await (program.methods as any)
        .updateExternalMintProgramsLimit(maxPrograms)
        .accountsStrict({
            config: configPda,
            externalMintProgramsLimitConfig: externalMintProgramsLimitConfigPda,
            signer: vaultPda,
            programData: programDataPda,
            systemProgram: SystemProgram.programId,
        })
        .instruction();

    // Inner TransactionMessage — vault PDA is payer and signer, satisfying
    // validate_program_update_authority.
    const innerTxMessage = new TransactionMessage({
        payerKey: vaultPda,
        recentBlockhash: (await connection.getLatestBlockhash()).blockhash,
        instructions: [innerIx],
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
    console.log(`   3. Confirm the limit changed via fetch_config or direct account read`);
}

main().catch(console.error);
