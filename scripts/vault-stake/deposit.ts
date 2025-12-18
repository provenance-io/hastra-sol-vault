import * as anchor from "@coral-xyz/anchor";
import {Program} from "@coral-xyz/anchor";
import yargs from "yargs";
import {VaultStake} from "../../target/types/vault_stake";
import {getAssociatedTokenAddress} from "@solana/spl-token";

const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);

const program = anchor.workspace.VaultStake as Program<VaultStake>;

const args = yargs(process.argv.slice(2))
    .option("mint", {
        type: "string",
        description: "Token that will be minted (e.g. PRIME)",
        required: true,
    })
    .option("vault", {
        type: "string",
        description: "Token that will be vaulted (e.g. wYLDS)",
        required: true,
    })
    .option("amount", {
        type: "number",
        description: "Amount of tokens to deposit and mint",
        required: true,
    })
    .option("vault_token_account", {
        type: "string",
        description: "Vault Token Account that holds the Vault Token (e.g. wYLDS)",
        required: true,
    })
    .parseSync();

const main = async () => {
    const signer = provider.wallet.publicKey;

    // Derive PDAs
    const [stakeConfigPda, bump] = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("stake_config")],
        program.programId
    );

    const [vaultAuthorityPda] = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("vault_authority")],
        program.programId
    );

    const [mintAuthorityPda] = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("mint_authority")],
        program.programId
    );

    const [stakeVaultTokenAccountConfigPda] = anchor.web3.PublicKey.findProgramAddressSync(
        [
            Buffer.from("stake_vault_token_account_config"),
            stakeConfigPda.toBuffer()
        ],
        program.programId
    );

    // Program args
    const mint = new anchor.web3.PublicKey(args.mint);
    const vault = new anchor.web3.PublicKey(args.vault);
    const amount = new anchor.BN(args.amount);
    const vaultTokenAccount = new anchor.web3.PublicKey(args.vault_token_account);
    const userMintTokenAccount = await getAssociatedTokenAddress(mint,signer)
    const userVaultTokenAccount = await getAssociatedTokenAddress(vault,signer)

    console.log("Mint (token to be minted e.g. PRIME)", mint.toBase58());
    console.log("Vault (token to be vaulted e.g. wYLDS)", vault.toBase58());
    console.log("Amount:", amount.toString());
    console.log("Vault Token Account (e.g. wYLDS)", vaultTokenAccount.toBase58());
    console.log("User Vault Token Account:", userVaultTokenAccount.toBase58());
    console.log("User Mint Token Account:", userMintTokenAccount.toBase58());
    console.log("Stake Config PDA:", stakeConfigPda.toBase58());
    console.log("Stake Vault Config PDA:", stakeVaultTokenAccountConfigPda.toBase58());
    console.log("Mint Authority PDA:", mintAuthorityPda.toBase58());
    console.log("Vault Authority PDA:", vaultAuthorityPda.toBase58());

    const tx = await program.methods
        .deposit(amount)
        .accountsStrict({
            stakeConfig: stakeConfigPda,
            stakeVaultTokenAccountConfig: stakeVaultTokenAccountConfigPda,
            vaultTokenAccount: vaultTokenAccount,
            vaultAuthority: vaultAuthorityPda,
            mint: mint,
            vaultMint: vault,
            mintAuthority: mintAuthorityPda,
            signer: signer,
            userVaultTokenAccount: userVaultTokenAccount,
            userMintTokenAccount: userMintTokenAccount,
            tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID
        }).rpc();

    console.log("Transaction:", tx);
};

main().catch(console.error);



