import * as anchor from "@coral-xyz/anchor";
import {Program} from "@coral-xyz/anchor";
import {VaultMint} from "../../target/types/vault_mint";
import {PublicKey} from "@solana/web3.js";
import yargs from "yargs";
import {TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync} from "@solana/spl-token";

const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);

const program = anchor.workspace.VaultMint as Program<VaultMint>;

const args = yargs(process.argv.slice(2))
    .option("account", {
        type: "string",
        description: "Owner of the token account to freeze",
        required: true,
    })
    .option("mint", {
        type: "string",
        description: "Mint address of the token to freeze",
        required: true,
    })
    .parseSync();

const main = async () => {
    const signer = provider.wallet.publicKey;

    // Derive PDAs
    const [configPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("config")],
        program.programId
    );

    const [freezeAuthorityPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("freeze_authority")],
        program.programId
    );

    const mint = new PublicKey(args.mint);
    const account = new PublicKey(args.account);

    // Calculate the Associated Token Account address
    const tokenAccount = getAssociatedTokenAddressSync(
        mint,
        account
    );

    console.log("Token Account Owner:", account.toBase58());
    console.log("Token Account:", tokenAccount.toBase58());
    console.log("Mint:", mint.toBase58());
    console.log("Config PDA:", configPda.toBase58());
    console.log("Freeze Authority PDA:", freezeAuthorityPda.toBase58());
    console.log("Freeze Administrator (signer):", signer.toBase58());

    try {
        const tx = await program.methods
            .freezeTokenAccount()
            .accountsStrict({
                config: configPda,
                tokenAccount: tokenAccount,
                mint: mint,
                freezeAuthorityPda: freezeAuthorityPda,
                signer: signer,
                tokenProgram: TOKEN_PROGRAM_ID,
            })
            .rpc();

        console.log("Transaction successful:", tx);
        console.log(`Token account ${tokenAccount.toBase58()} has been frozen`);
    } catch (error) {
        console.error("Error freezing token account:", error);
        throw error;
    }
};

main().catch(console.error);
