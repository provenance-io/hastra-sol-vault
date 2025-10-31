import * as anchor from "@coral-xyz/anchor";
import yargs from "yargs";
import {Program} from "@coral-xyz/anchor";
import {VaultStake} from "../../target/types/vault_stake";

const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);

const program = anchor.workspace.VaultStake as Program<VaultStake>;

const args = yargs(process.argv.slice(2))
    .option("mint", {
        type: "string",
        description: "The staking mint token that will be burned (e.g. PRIME) at redeem.",
        required: true,
    })

    .option("vault_token_account", {
        type: "string",
        description: "Vault Token Account that holds the Vault Token (e.g. wYLDS)",
        required: true,
    })
    .option("user_vault_token_account", {
        type: "string",
        description: "User's vault token account address where the vaulted tokens will be sent to. Must be associated token account for the vault token (e.g. wYLDS)",
        required: true,
    })
    .option("user_mint_token_account", {
        type: "string",
        description: "User's mint token account address where the staking mint tokens (e.g. PRIME) will be burned. Must be associated token account for the mint token (e.g. PRIME)",
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

    const [ticketPda] = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("ticket"), signer.toBuffer()],
        program.programId
    );

    // Program args
    const mint = new anchor.web3.PublicKey(args.mint);
    const vaultTokenAccount = new anchor.web3.PublicKey(args.vault_token_account);
    const userVaultTokenAccount = new anchor.web3.PublicKey(args.user_vault_token_account);
    const userMintTokenAccount = new anchor.web3.PublicKey(args.user_mint_token_account);

    console.log(`Signer: ${mint.toBase58()}`);
    console.log(`Mint (token to be burned e.g. PRIME): ${mint.toBase58()}`);
    console.log(`Vault Token Account (e.g. wYLDS): ${vaultTokenAccount.toBase58()}`);
    console.log(`User Vault Token Account: ${userVaultTokenAccount.toBase58()}`);
    console.log(`Stake Config PDA: ${stakeConfigPda.toBase58()}`);
    console.log(`Vault Authority PDA: ${vaultAuthorityPda.toBase58()}`);
    console.log(`Ticket PDA: ${ticketPda.toBase58()}`);

    const tx = await program.methods
        .redeem()
        .accountsStrict({
            stakeConfig: stakeConfigPda,
            vaultTokenAccount: vaultTokenAccount,
            vaultAuthority: vaultAuthorityPda,
            signer: signer,
            userVaultTokenAccount: userVaultTokenAccount,
            userMintTokenAccount: userMintTokenAccount,
            mint: mint,
            tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
            ticket: ticketPda
        }).rpc();

    console.log("Transaction:", tx);
};

main().catch(console.error);



