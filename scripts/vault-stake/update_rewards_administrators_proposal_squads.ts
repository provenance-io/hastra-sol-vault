/**
 * update_rewards_administrators_proposal_squads.ts
 *
 * Creates a Squads v4 vault transaction proposal to call updateRewardsAdministrators
 * on vault-stake. The vault PDA must match the program upgrade authority.
 *
 * The list is replace-all: every intended rewards administrator must be included.
 * Pass --program_id for AUTO / SMB pools.
 *
 * Usage:
 *   ANCHOR_PROVIDER_URL=https://api.mainnet-beta.solana.com \
 *   ANCHOR_WALLET=~/.config/solana/squad-member.json \
 *   yarn ts-node scripts/vault-stake/update_rewards_administrators_proposal_squads.ts \
 *     --multisig_pda <SQUADS_V4_MULTISIG_PDA> \
 *     --rewards_administrators <PUBKEY_1>[,<PUBKEY_2>,...]
 *
 * Optional:
 *   --program_id <PUBKEY>       vault-stake program id when it differs from the workspace IDL
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
    .option("rewards_administrators", {
        type: "string",
        description:
            "Comma-separated list of rewards administrator public keys (replace-all, 1–5 unique)",
        required: true,
    })
    .option("program_id", {
        type: "string",
        description:
            "Optional vault-stake program id override (PRIME / AUTO / SMB when local IDL address differs)",
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
const program = new anchor.Program(resolvedIdl as anchor.Idl, provider) as Program<VaultStake>;

function parseAdministrators(csv: string, label: string): PublicKey[] {
    const keys = csv
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
        .map((s) => new PublicKey(s));
    if (keys.length === 0) {
        throw new Error(`${label} must contain at least one public key`);
    }
    if (keys.length > 5) {
        throw new Error(`${label} length (${keys.length}) exceeds maximum 5`);
    }
    for (let i = 0; i < keys.length; i++) {
        if (keys.slice(0, i).some((k) => k.equals(keys[i]))) {
            throw new Error(`${label} contains duplicate key: ${keys[i].toBase58()}`);
        }
    }
    return keys;
}

async function main() {
    const msPDA = new PublicKey(args.multisig_pda);
    const connection = provider.connection;
    const member = provider.wallet.payer;
    const vaultIndex = Number(args.vault_index);

    if (!Number.isInteger(vaultIndex) || vaultIndex < 0) {
        throw new Error("--vault_index must be a non-negative integer");
    }

    const rewardsAdministrators = parseAdministrators(
        args.rewards_administrators,
        "rewards_administrators"
    );

    const [stakeConfigPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("stake_config")],
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

    console.log("=== update_rewards_administrators Squads Proposal (v4 SDK, vault-stake) ===\n");
    console.log("Program ID:             ", program.programId.toBase58());
    console.log("Multisig PDA:           ", msPDA.toBase58());
    console.log("Vault PDA (signer):     ", vaultPda.toBase58());
    console.log("Vault index:            ", vaultIndex);
    console.log("Stake Config PDA:       ", stakeConfigPda.toBase58());
    console.log("Program Data PDA:       ", programData.toBase58());
    console.log("Proposal index:         ", transactionIndex.toString());
    console.log(
        "Rewards administrators: ",
        rewardsAdministrators.map((k) => k.toBase58()).join(", ")
    );
    console.log();

    // Vault PDA signs as upgrade authority when Squads executes the proposal.
    const ix = await program.methods
        .updateRewardsAdministrators(rewardsAdministrators)
        .accountsStrict({
            stakeConfig: stakeConfigPda,
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
    console.log(`   1. Confirm vault PDA matches this pool's upgrade authority`);
    console.log(`   2. Squad members approve at https://app.squads.so (devnet: backup.app.squads.so)`);
    console.log(`   3. Execute after threshold is met`);
    console.log(`   4. Confirm rewards_administrators on stake_config ${stakeConfigPda.toBase58()}`);
}

main().catch(console.error);
