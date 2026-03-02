import * as multisig from "@squads-protocol/multisig";
import {
    PublicKey,
    TransactionMessage,
    VersionedTransaction,
} from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import yargs from "yargs";

const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);

const args = yargs(process.argv.slice(2))
    .option("multisig_pda", {
        type: "string",
        description: "Squads multisig PDA",
        required: true,
    })
    .parseSync();
// === CONFIG ===

const connection = provider.connection;
const member = provider.wallet.payer;

async function main() {
    const msPDA = new PublicKey(args.multisig_pda);

    const accountInfo = await connection.getAccountInfo(msPDA);
    if (!accountInfo) throw new Error("Multisig account not found");
    console.log(`Account data length: ${accountInfo.data.length}`);
    console.log(`Owner: ${accountInfo.owner.toBase58()}`);

    const transactionIndex = accountInfo.data.readBigUInt64LE(78) + BigInt(1);
    console.log(`Next transaction index: ${transactionIndex}`);

    const [vaultPda] = multisig.getVaultPda({ multisigPda: msPDA, index: 0 });

    const txMessage = new TransactionMessage({
        payerKey: vaultPda,
        recentBlockhash: (await connection.getLatestBlockhash()).blockhash,
        instructions: [
            {
                programId: new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"),
                keys: [{ pubkey: vaultPda, isSigner: true, isWritable: false }],
                data: Buffer.from("signing test"),
            },
        ],
    });

    const ix1 = multisig.instructions.vaultTransactionCreate({
        multisigPda: msPDA,
        transactionIndex,
        creator: member.publicKey,
        vaultIndex: 0,
        ephemeralSigners: 0,
        transactionMessage: txMessage,
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
    console.log(`✅ Memo proposal #${transactionIndex} created`);
    console.log(`   https://solscan.io/tx/${sig}`);
    console.log(`\n   Members can now approve at https://app.squads.so`);
}

main().catch(console.error);
