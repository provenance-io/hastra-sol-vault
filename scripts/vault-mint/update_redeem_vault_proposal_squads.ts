/**
 * update_redeem_vault_proposal_squads.ts
 *
 * Creates a Squads v4 vault transaction proposal to call updateRedeemVault on vault-mint.
 * The vault PDA must match the program upgrade authority.
 *
 * Required once after the upgrade that pins complete_redeem / sweep_redeem_vault_funds to
 * config.redeem_vault, on deployments that initialized before that field was written.
 * Until this proposal executes, those instructions fail closed on InvalidRedeemVault.
 *
 * Usage:
 *   ANCHOR_PROVIDER_URL=https://api.mainnet-beta.solana.com \
 *   ANCHOR_WALLET=~/.config/solana/squad-member.json \
 *   yarn ts-node scripts/vault-mint/update_redeem_vault_proposal_squads.ts \
 *     --multisig_pda <SQUADS_V4_MULTISIG_PDA> \
 *     --redeem_vault_token_account <PUBKEY>
 *
 * Optional:
 *   --program_id <PUBKEY>       override vault-mint program id
 *   --vault_pda <PUBKEY>        when upgrade authority differs from SDK-derived vault index 0
 *   --vault_index <N>           vault index for derivation / vaultTransactionCreate (default 0)
 *   --transaction_index <N>     override next proposal index (otherwise u64 LE @ offset 78 + 1)
 */

import * as multisig from "@squads-protocol/multisig";
import {
    PublicKey,
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
    .option("redeem_vault_token_account", {
        type: "string",
        description:
            "PDA-owned redeem vault token account to pin as config.redeem_vault (must match config.vault mint)",
        required: true,
    })
    .option("program_id", {
        type: "string",
        description: "Optional vault-mint program id override",
    })
    .option("vault_pda", {
        type: "string",
        description:
            "Override the Squads-derived vault PDA when the upgrade authority differs from the SDK-derived vault",
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

    if (!Number.isInteger(vaultIndex) || vaultIndex < 0) {
        throw new Error("--vault_index must be a non-negative integer");
    }

    const redeemVaultTokenAccount = new PublicKey(args.redeem_vault_token_account);

    const [configPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("config")],
        program.programId
    );
    const [programData] = PublicKey.findProgramAddressSync(
        [program.programId.toBuffer()],
        BPF_LOADER_UPGRADEABLE_ID
    );
    const [redeemVaultAuthorityPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("redeem_vault_authority")],
        program.programId
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

    console.log("=== update_redeem_vault Squads Proposal (v4 SDK, vault-mint) ===\n");
    console.log("Program ID:                 ", program.programId.toBase58());
    console.log("Multisig PDA:               ", msPDA.toBase58());
    console.log("Vault PDA (signer):         ", vaultPda.toBase58());
    console.log("Vault index:                ", vaultIndex);
    console.log("Config PDA:                 ", configPda.toBase58());
    console.log("Program Data PDA:           ", programData.toBase58());
    console.log("Redeem Vault Authority PDA: ", redeemVaultAuthorityPda.toBase58());
    console.log("Redeem Vault Token Account: ", redeemVaultTokenAccount.toBase58());
    console.log("Proposal index:             ", transactionIndex.toString());
    console.log();

    // Vault PDA signs as upgrade authority when Squads executes the proposal.
    const ix = await program.methods
        .updateRedeemVault()
        .accountsStrict({
            config: configPda,
            redeemVaultAuthority: redeemVaultAuthorityPda,
            redeemVaultTokenAccount: redeemVaultTokenAccount,
            programData,
            signer: vaultPda,
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
    console.log(`   3. Execute after the redeem-vault pin program upgrade has landed`);
    console.log(
        `   4. Confirm config.redeem_vault == ${redeemVaultTokenAccount.toBase58()} on ${configPda.toBase58()}`
    );
    console.log(`   5. complete_redeem / sweep_redeem_vault_funds can proceed against that account`);
}

main().catch(console.error);
