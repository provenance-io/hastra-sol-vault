import * as anchor from "@coral-xyz/anchor";
import yargs from "yargs";
import {Program} from "@coral-xyz/anchor";
import {VaultMint} from "../../target/types/vault_mint";
import {PublicKey, SystemProgram} from "@solana/web3.js";
import {getAssociatedTokenAddress} from "@solana/spl-token";

const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);

const program = anchor.workspace.VaultMint as Program<VaultMint>;

const args = yargs(process.argv.slice(2))
    .option("amount", {
        type: "number",
        description: "The amount of mint token that will be redeemed.",
        required: true,
    })
    .option("mint", {
        type: "string",
        description: "The mint token that will be burned (e.g. wYLDS) at redeem.",
        required: true,
    })
    .parseSync();

const main = async () => {
    const signer = provider.wallet.publicKey;

    // Derive PDAs
    const [configPda] = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("config")],
        program.programId
    );

    // Derive the redemption request PDA
    const [redemptionRequestPda] = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("redemption_request"), signer.toBuffer()],
        program.programId
    );

    // Program args
    const mint = new anchor.web3.PublicKey(args.mint);
    const [redeemVaultAuthorityPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("redeem_vault_authority")],
        program.programId
    );

    // Get user's mint token account
    const userMintTokenAccount = await getAssociatedTokenAddress(
        mint,
        signer,
    );

    console.log(`Signer: ${signer.toBase58()}`);
    console.log(`Mint (token to be burned e.g. wYLDS): ${mint.toBase58()}`);
    console.log(`Amount: ${args.amount}`);
    console.log(`User Mint Token Account: ${userMintTokenAccount.toBase58()}`);
    console.log(`Config PDA: ${configPda.toBase58()}`);
    console.log(`Redemption Request PDA: ${redemptionRequestPda.toBase58()}`);
    console.log(`Redeem Vault Authority PDA: ${redeemVaultAuthorityPda.toBase58()}`);

    const tx = await program.methods
        .requestRedeem(new anchor.BN(args.amount))
        .accountsStrict({
            signer: signer,
            userMintTokenAccount: userMintTokenAccount,
            redemptionRequest: redemptionRequestPda,
            mint: mint,
            config: configPda,
            systemProgram: SystemProgram.programId,
            tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
            redeemVaultAuthority: redeemVaultAuthorityPda
        }).rpc();

    console.log("Transaction:", tx);
};

main().catch(console.error);



