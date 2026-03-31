import * as anchor from "@coral-xyz/anchor";
import {Program} from "@coral-xyz/anchor";
import yargs from "yargs";
import {VaultStakeAuto} from "../../target/types/vault_stake_auto";
import {PublicKey} from "@solana/web3.js";

const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);

const program = anchor.workspace.VaultStakeAuto as Program<VaultStakeAuto>;

const args = yargs(process.argv.slice(2))
    .option("mint", {
        type: "string",
        description: "The staking mint token that will be burned (e.g. AUTO) at redeem.",
        required: true,
    })
    .option("vault_mint", {
        type: "string",
        description: "Vaulted mint token (e.g. wYLDS)",
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
        description: "User's ATA for the staking mint (e.g. AUTO) to burn; must match mint decimals.",
        required: true,
    })
    .option("amount", {
        type: "number",
        description: "Amount to redeem. Must be less than or equal to the amount staked.",
        required: true,
    })
    .parseSync();

const main = async () => {
    const signer = provider.wallet.publicKey;

    // Derive PDAs
    const [stakeConfigPda] = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("stake_config")],
        program.programId
    );

    const [vaultAuthorityPda] = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("vault_authority")],
        program.programId
    );

    const [stakeVaultTokenAccountConfigPda] = anchor.web3.PublicKey.findProgramAddressSync(
        [
            Buffer.from("stake_vault_token_account_config"),
            stakeConfigPda.toBuffer()
        ],
        program.programId
    );

    const [stakePriceConfigPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("stake_price_config"), stakeConfigPda.toBuffer()],
        program.programId
    );


    // The unbonding flow was removed. The ticket account is now optional:
    //   - If a legacy UnbondingTicket PDA exists on-chain, pass its address so the
    //     program closes it and returns rent to the signer.
    //   - If no ticket exists, pass program.programId as the Anchor 0.31 None sentinel
    //     (Anchor treats pubkey == programId as Option::None and skips all constraints).
    const [ticketPda] = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("ticket"), signer.toBuffer()],
        program.programId
    );
    const legacyTicketInfo = await provider.connection.getAccountInfo(ticketPda);
    const ticketAccount = legacyTicketInfo !== null ? ticketPda : program.programId;

    // Program args
    const mint = new anchor.web3.PublicKey(args.mint);
    const vaultMint = new anchor.web3.PublicKey(args.vault_mint);
    const vaultTokenAccount = new anchor.web3.PublicKey(args.vault_token_account);
    const userVaultTokenAccount = new anchor.web3.PublicKey(args.user_vault_token_account);
    const userMintTokenAccount = new anchor.web3.PublicKey(args.user_mint_token_account);

    console.log(`Signer: ${signer.toBase58()}`);
    console.log(`Mint (token to be burned e.g. AUTO): ${mint.toBase58()}`);
    console.log(`Vault Token Account (e.g. wYLDS): ${vaultTokenAccount.toBase58()}`);
    console.log(`User Vault Token Account: ${userVaultTokenAccount.toBase58()}`);
    console.log(`Stake Config PDA: ${stakeConfigPda.toBase58()}`);
    console.log(`Vault Authority PDA: ${vaultAuthorityPda.toBase58()}`);
    console.log(`Legacy Ticket PDA: ${ticketPda.toBase58()} (${legacyTicketInfo !== null ? "found — will be closed and rent returned" : "not found — skipped"})`);

    const tx = await program.methods
        .redeem(new anchor.BN(String(Math.trunc(args.amount)), 10))
        .accountsStrict({
            stakeConfig: stakeConfigPda,
            stakeVaultTokenAccountConfig: stakeVaultTokenAccountConfigPda,
            stakePriceConfig: stakePriceConfigPda,
            vaultTokenAccount: vaultTokenAccount,
            vaultAuthority: vaultAuthorityPda,
            signer: signer,
            ticket: ticketAccount,
            userVaultTokenAccount: userVaultTokenAccount,
            userMintTokenAccount: userMintTokenAccount,
            mint: mint,
            vaultMint: vaultMint,
            tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        }).rpc();

    console.log("Transaction:", tx);
};

main().catch(console.error);
