import * as anchor from "@coral-xyz/anchor";
import {Program} from "@coral-xyz/anchor";
import {VaultStake} from "../../target/types/vault_stake";
import {PublicKey} from "@solana/web3.js";
import yargs from "yargs";
import {TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync} from "@solana/spl-token";

const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);

const program = anchor.workspace.VaultStake as Program<VaultStake>;

const args = yargs(process.argv.slice(2))
    .option("account", {
        type: "string",
        description: "Account owner of the token account to thaw",
        required: true,
    })
    .option("mint", {
        type: "string",
        description: "Mint address of the token to thaw",
        required: true,
    })
    .parseSync();

const main = async () => {
    const signer = provider.wallet.publicKey;

    // Derive PDAs
    const [stakeConfigPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("stake_config")],
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

    console.log("Account Owner:", account.toBase58());
    console.log("Calculated Token Account:", tokenAccount.toBase58());
    console.log("Mint:", mint.toBase58());
    console.log("Stake Config PDA:", stakeConfigPda.toBase58());
    console.log("Freeze Authority PDA:", freezeAuthorityPda.toBase58());
    console.log("Freeze Administrator (signer):", signer.toBase58());

    try {
        const tx = await program.methods
            .thawTokenAccount()
            .accountsStrict({
                stakeConfig: stakeConfigPda,
                tokenAccount: tokenAccount,
                mint: mint,
                freezeAuthorityPda: freezeAuthorityPda,
                signer: signer,
                tokenProgram: TOKEN_PROGRAM_ID,
            })
            .rpc();

        console.log("Transaction successful:", tx);
        console.log(`Token account ${tokenAccount.toBase58()} has been thawed`);
    } catch (error) {
        console.error("Error thawing token account:", error);
        throw error;
    }
};

main().catch(console.error);
