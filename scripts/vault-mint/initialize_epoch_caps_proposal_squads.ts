/**
 * initialize_epoch_caps_proposal_squads.ts
 *
 * Creates a Squads v4 (@squads-protocol/multisig) vault transaction proposal to call
 * initializeEpochCaps on vault-mint. Uses vaultTransactionCreate + proposalCreate
 * in a single outer transaction (same pattern as initialize_price_config_proposal.ts).
 *
 * Run after the program upgrade that adds epoch caps has executed. The vault PDA must
 * match the program upgrade authority; it also pays rent for EpochCapsConfig.
 *
 * Usage:
 *   ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
 *   ANCHOR_WALLET=~/.config/solana/squad-member.json \
 *   yarn ts-node scripts/vault-mint/initialize_epoch_caps_proposal_squads.ts \
 *     --multisig_pda <SQUADS_V4_MULTISIG_PDA> \
 *     --first_capped_epoch <INDEX> \
 *     --max_epoch_cap <RAW_UNITS>
 *
 * Optional overrides:
 *   --vault_pda <PUBKEY>        when upgrade authority differs from SDK-derived vault index 0
 *   --transaction_index <N>     override next proposal index (otherwise u64 LE @ offset 78 + 1)
 *   --program_id <PUBKEY>       override vault-mint program id
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
    .option("first_capped_epoch", {
        type: "number",
        description: "First epoch index that enforces aggregate claim caps",
        required: true,
    })
    .option("max_epoch_cap", {
        type: "string",
        description: "Global ceiling on create_rewards_epoch.total (raw token units)",
        required: true,
    })
    .option("vault_pda", {
        type: "string",
        description:
            "Override the Squads-derived vault PDA when the upgrade authority differs from the SDK-derived vault",
        required: false,
    })
    .option("transaction_index", {
        type: "string",
        description:
            "Override the next transaction index (otherwise u64 LE @ offset 78 of the multisig account + 1)",
        required: false,
    })
    .option("program_id", {
        type: "string",
        description: "Optional vault-mint program id override",
        required: false,
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

    const [configPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("config")],
        program.programId
    );
    const [epochCapsConfigPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("epoch_caps_config")],
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

    console.log("=== initialize_epoch_caps Squads Proposal (v4 SDK) ===\n");
    console.log("Vault Mint Program ID:   ", program.programId.toBase58());
    console.log("Multisig PDA:            ", msPDA.toBase58());
    console.log("Vault PDA (signer):      ", vaultPda.toBase58());
    console.log("Config PDA:              ", configPda.toBase58());
    console.log("Epoch Caps Config PDA:   ", epochCapsConfigPda.toBase58());
    console.log("Program Data:            ", programData.toBase58());
    console.log("Proposal index:          ", transactionIndex.toString());
    console.log("First capped epoch:      ", args.first_capped_epoch);
    console.log("Max epoch cap:           ", args.max_epoch_cap);
    console.log();

    // Vault PDA signs as upgrade authority when Squads executes the proposal.
    const ix = await program.methods
        .initializeEpochCaps(
            new BN(args.first_capped_epoch),
            new BN(args.max_epoch_cap),
        )
        .accountsStrict({
            config: configPda,
            epochCapsConfig: epochCapsConfigPda,
            signer: vaultPda,
            programData,
            systemProgram: SystemProgram.programId,
        })
        .instruction();

    // Vault pays rent for the new EpochCapsConfig account.
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
    console.log(`   1. Confirm vault PDA matches vault-mint upgrade authority`);
    console.log(`   2. Squad members approve at https://app.squads.so (devnet: backup.app.squads.so)`);
    console.log(`   3. Execute after the epoch-caps program upgrade has landed`);
    console.log(`   4. Confirm epoch_caps_config at ${epochCapsConfigPda.toBase58()}`);
}

main().catch(console.error);
