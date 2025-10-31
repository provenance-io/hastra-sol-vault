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
        description: "Mint token that will be burned (e.g. PRIME) after unbonding period.",
        required: true,
    })
    .option("amount", {
        type: "number",
        description: "Amount of mint tokens to burn at unbond",
        required: true,
    })
    .option("user_mint_token_account", {
        type: "string",
        description: "User's mint token account where tokens will be burned from. Must be associated token account for the burned mint token (e.g. PRIME)",
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

    // Derive ticket PDA
    const [ticketPda] = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("ticket"), signer.toBuffer()],
        program.programId
    );

    // Program args
    const mint = new anchor.web3.PublicKey(args.mint);
    const amount = new anchor.BN(args.amount);
    const userMintTokenAccount = new anchor.web3.PublicKey(args.user_mint_token_account);

    console.log("Burned Mint (token to be burned e.g. PRIME)", mint.toBase58());
    console.log("Amount:", amount.toString());
    console.log("User Mint Token Account to be burned:", userMintTokenAccount.toBase58());
    console.log("User Unbonding Ticket:", ticketPda.toBase58());
    console.log("Stake Config PDA:", stakeConfigPda.toBase58());

    const tx = await program.methods
        .unbond(amount)
        .accountsStrict({
            stakeConfig: stakeConfigPda,
            mint: mint,
            signer: signer,
            userMintTokenAccount: userMintTokenAccount,
            ticket: ticketPda,
            systemProgram: anchor.web3.SystemProgram.programId,
        }).rpc();

    console.log("Transaction:", tx);
};

main().catch(console.error);



