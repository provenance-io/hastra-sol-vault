/**
 * register_allowed_external_mint_program_proposal_squads.ts
 *
 * Creates a Squads v4 (@squads-protocol/multisig) vault transaction proposal to call
 * registerAllowedExternalMintProgram on vault-mint. Uses vaultTransactionCreate + proposalCreate
 * in a single outer transaction (see initialize_price_config_proposal.ts on vault-stake).
 *
 * If the multisig is Squads v3 (program SMPLecH...), use
 * register_allowed_external_mint_program_proposal_squads_v3.ts instead.
 *
 * On first registration, init_if_needed allocates the AllowedExternalMintPrograms PDA;
 * the vault PDA pays rent — ensure the Squads vault has enough SOL before executing.
 *
 * Usage:
 *   ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
 *   ANCHOR_WALLET=~/.config/solana/squad-member.json \
 *   yarn ts-node scripts/vault-mint/register_allowed_external_mint_program_proposal_squads.ts \
 *     --multisig_pda <SQUADS_V4_MULTISIG_PDA> \
 *     --external_program <VAULT_STAKE_AUTO_PROGRAM_ID>
 *
 * Optional overrides (same semantics as initialize_price_config_proposal):
 *   --vault_pda <PUBKEY>        when upgrade authority differs from SDK-derived vault index 0
 *   --transaction_index <N>     when offset-78 read is wrong for non-v4 multisigs
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

const program = anchor.workspace.VaultMint as Program<VaultMint>;

const BPF_LOADER_UPGRADEABLE_ID = new PublicKey(
    "BPFLoaderUpgradeab1e11111111111111111111111"
);

const args = yargs(process.argv.slice(2))
    .option("multisig_pda", {
        type: "string",
        description: "Squads multisig account address",
        required: true,
    })
    .option("external_program", {
        type: "string",
        description:
            "Program ID of the external staking program to authorize (e.g. vault-stake-auto)",
        required: true,
    })
    .option("vault_pda", {
        type: "string",
        description:
            "Override the Squads-derived vault PDA (needed when the multisig is Squads v3 or when the upgrade authority differs from the SDK-derived vault)",
        required: false,
    })
    .option("transaction_index", {
        type: "string",
        description:
            "Override the next transaction index read from the multisig account (needed when offset-78 gives garbage, e.g. for Squads v3 accounts)",
        required: false,
    })
    .parseSync();

async function main() {
    const msPDA = new PublicKey(args.multisig_pda);
    const externalProgram = new PublicKey(args.external_program);
    const connection = provider.connection;
    const member = provider.wallet.payer;

    const [configPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("config")],
        program.programId
    );

    const [allowedExternalMintProgramsPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("allowed_external_mint_programs"), configPda.toBuffer()],
        program.programId
    );

    const [programData] = PublicKey.findProgramAddressSync(
        [program.programId.toBuffer()],
        BPF_LOADER_UPGRADEABLE_ID
    );

    const [vaultPdaDerived] = multisig.getVaultPda({ multisigPda: msPDA, index: 0 });
    const vaultPda = args.vault_pda ? new PublicKey(args.vault_pda) : vaultPdaDerived;

    let transactionIndex: bigint;
    if (args.transaction_index !== undefined) {
        transactionIndex = BigInt(args.transaction_index);
    } else {
        const accountInfo = await connection.getAccountInfo(msPDA);
        if (!accountInfo) throw new Error(`Multisig account not found: ${msPDA.toBase58()}`);
        transactionIndex = accountInfo.data.readBigUInt64LE(78) + BigInt(1);
    }

    console.log("=== registerAllowedExternalMintProgram Squads Proposal (v4 SDK) ===\n");
    console.log("Vault Mint Program ID:                  ", program.programId.toBase58());
    console.log("Multisig PDA:                           ", msPDA.toBase58());
    console.log("Vault PDA (signer):                     ", vaultPda.toBase58());
    console.log("Config PDA:                             ", configPda.toBase58());
    console.log("AllowedExternalMintPrograms PDA:       ", allowedExternalMintProgramsPda.toBase58());
    console.log("External program to register:          ", externalProgram.toBase58());
    console.log("Program Data:                           ", programData.toBase58());
    console.log("Proposal index:                         ", transactionIndex.toString());
    console.log();

    const ix = await program.methods
        .registerAllowedExternalMintProgram()
        .accountsStrict({
            config: configPda,
            allowedExternalMintPrograms: allowedExternalMintProgramsPda,
            externalProgram: externalProgram,
            signer: vaultPda,
            programData: programData,
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
        vaultIndex: 0,
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
    console.log(`   3. Confirm ${externalProgram.toBase58()} is authorized for external_program_mint CPI`);
}

main().catch(console.error);
