/**
 * update_max_epoch_cap_proposal_squads.ts
 *
 * Creates a Squads v4 (@squads-protocol/multisig) vault transaction proposal to call
 * updateMaxEpochCap on vault-mint. Uses vaultTransactionCreate + proposalCreate
 * in a single outer transaction (same pattern as initialize_epoch_caps_proposal_squads.ts).
 *
 * Requires EpochCapsConfig to already exist (initialize_epoch_caps). Affects future
 * create_rewards_epoch calls only; the vault PDA must match the program upgrade authority.
 *
 * Usage:
 *   ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
 *   ANCHOR_WALLET=~/.config/solana/squad-member.json \
 *   yarn ts-node scripts/vault-mint/update_max_epoch_cap_proposal_squads.ts \
 *     --multisig_pda <SQUADS_V4_MULTISIG_PDA> \
 *     --new_cap <RAW_UNITS>
 *
 * Optional overrides:
 *   --vault_pda <PUBKEY>        when upgrade authority differs from SDK-derived vault index 0
 *   --vault_index <N>           vault index for derivation / vaultTransactionCreate (default 0)
 *   --transaction_index <N>     override next proposal index (otherwise u64 LE @ offset 78 + 1)
 *   --program_id <PUBKEY>       override vault-mint program id
 */

import * as multisig from "@squads-protocol/multisig";
import {
    PublicKey,
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
    .option("new_cap", {
        type: "string",
        description: "New global ceiling on create_rewards_epoch.total (raw token units, must be > 0)",
        required: true,
    })
    .option("vault_pda", {
        type: "string",
        description:
            "Override the Squads-derived vault PDA when the upgrade authority differs from the SDK-derived vault",
        required: false,
    })
    .option("vault_index", {
        type: "number",
        description: "Vault index for getVaultPda and vaultTransactionCreate (default 0)",
        default: 0,
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
    const vaultIndex = Number(args.vault_index);
    const newCap = new BN(args.new_cap);

    if (!Number.isInteger(vaultIndex) || vaultIndex < 0) {
        throw new Error("--vault_index must be a non-negative integer");
    }
    if (newCap.lte(new BN(0))) {
        throw new Error("--new_cap must be greater than 0");
    }

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

    console.log("=== update_max_epoch_cap Squads Proposal (v4 SDK) ===\n");
    console.log("Vault Mint Program ID:   ", program.programId.toBase58());
    console.log("Multisig PDA:            ", msPDA.toBase58());
    console.log("Vault PDA (signer):      ", vaultPda.toBase58());
    console.log("Vault index:             ", vaultIndex);
    console.log("Config PDA:              ", configPda.toBase58());
    console.log("Epoch Caps Config PDA:   ", epochCapsConfigPda.toBase58());
    console.log("Program Data:            ", programData.toBase58());
    console.log("Proposal index:          ", transactionIndex.toString());
    console.log("New max epoch cap:       ", args.new_cap);
    console.log();

    // Vault PDA signs as upgrade authority when Squads executes the proposal.
    const ix = await program.methods
        .updateMaxEpochCap(newCap)
        .accountsStrict({
            config: configPda,
            epochCapsConfig: epochCapsConfigPda,
            signer: vaultPda,
            programData,
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
    console.log(`   1. Confirm vault PDA matches vault-mint upgrade authority`);
    console.log(`   2. Squad members approve at https://app.squads.so (devnet: backup.app.squads.so)`);
    console.log(`   3. Once the approval threshold is met, execute the proposal`);
    console.log(`   4. Confirm max_epoch_cap on epoch_caps_config at ${epochCapsConfigPda.toBase58()}`);
}

main().catch(console.error);
