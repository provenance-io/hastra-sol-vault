import * as anchor from "@coral-xyz/anchor";
import yargs from "yargs";
import {Program} from "@coral-xyz/anchor";
import {VaultMint} from "../../target/types/vault_mint";

const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);

const program = anchor.workspace.VaultMint as Program<VaultMint>;

const args = yargs(process.argv.slice(2))
    .option("mint", {
        type: "string",
        description: "Token that will be minted (e.g. wYLDS) upon receipt of the vault token (e.g. USDC)",
        required: true,
    })
    .option("amount", {
        type: "number",
        description: "Amount of tokens to deposit and mint",
        required: true,
    })
    .option("vault_token_account", {
        type: "string",
        description: "Vault Token Account that holds the Vault Token (e.g. USDC)",
        required: true,
    })
    .option("user_vault_token_account", {
        type: "string",
        description: "User's vault token account address where the vaulted tokens will be taken from. Must be associated token account for the vault token (e.g. USDC)",
        required: true,
    })
    .option("user_mint_token_account", {
        type: "string",
        description: "User's mint token account address where the minted tokens will be sent to. Must be associated token account for the mint token (e.g. wYLDS)",
        required: true,
    })
    .parseSync();

const main = async () => {
    const signer = provider.wallet.publicKey;

    // Derive PDAs
    const [configPda, bump] = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("config")],
        program.programId
    );

    const [mintAuthorityPda] = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("mint_authority")],
        program.programId
    );

    // Program args
    const mint = new anchor.web3.PublicKey(args.mint);
    const amount = new anchor.BN(args.amount);
    const vaultTokenAccount = new anchor.web3.PublicKey(args.vault_token_account);
    const userVaultTokenAccount = new anchor.web3.PublicKey(args.user_vault_token_account);
    const userMintTokenAccount = new anchor.web3.PublicKey(args.user_mint_token_account);

    console.log("Mint (token to be minted e.g. wYLDS)", mint.toBase58());
    console.log("Amount:", amount.toString());
    console.log("Vault Token Account (e.g. USDC)", vaultTokenAccount.toBase58());
    console.log("User Vault Token Account:", userVaultTokenAccount.toBase58());
    console.log("User Mint Token Account:", userMintTokenAccount.toBase58());
    console.log("Config PDA:", configPda.toBase58());
    console.log("Mint Authority PDA:", mintAuthorityPda.toBase58());

    const tx = await program.methods
        .deposit(amount)
        .accountsStrict({
            config: configPda,
            vaultTokenAccount: vaultTokenAccount,
            mint: mint,
            mintAuthority: mintAuthorityPda,
            signer: signer,
            userVaultTokenAccount: userVaultTokenAccount,
            userMintTokenAccount: userMintTokenAccount,
            tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID
        }).rpc();

    console.log("Transaction:", tx);
};

main().catch(console.error);



