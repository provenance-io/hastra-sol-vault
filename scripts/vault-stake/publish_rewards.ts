import * as anchor from "@coral-xyz/anchor";
import {Program} from "@coral-xyz/anchor";
import yargs from "yargs";
import {VaultStake} from "../../target/types/vault_stake";
import {getAccount, TOKEN_PROGRAM_ID} from "@solana/spl-token";

const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);

const program = anchor.workspace.VaultStake as Program<VaultStake>;

const args = yargs(process.argv.slice(2))
    .option("mint_program", {
        type: "string",
        description: "The address of the Hastra Mint program",
        required: true,
    })
    .option("stake_program", {
        type: "string",
        description: "The address of this program (Hastra stake program)",
        required: true,
    })
    .option("rewards_mint", {
        type: "string",
        description: "Token mint address for the rewards token (e.g. wYLDS)",
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
    const [stakeConfigPda] = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("stake_config")],
        program.programId
    );

    const [vaultAuthorityPda] = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("vault_authority")],
        program.programId
    );

    // Program args
    const rewardsMint = new anchor.web3.PublicKey(args.rewards_mint);
    const amount = new anchor.BN(args.amount);
    const vaultTokenAccount = new anchor.web3.PublicKey(args.vault_token_account);
    const mintProgramId = new anchor.web3.PublicKey(args.mint_program)
    const stakeProgramId = new anchor.web3.PublicKey(args.stake_program)

    const [rewardsMintAuthorityPda] = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("mint_authority")],
        mintProgramId
    );

    const [mintConfigPda] = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("config")],
        mintProgramId
    );

    const [externalMintAuthorityPda] = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("external_mint_authority")],
        stakeProgramId
    );
    console.log("Rewards Mint (token to be minted e.g. wYLDS)", rewardsMint.toBase58());
    console.log("Amount:", amount.toString());
    console.log("Mint Program:", mintProgramId.toBase58());
    console.log("Stake Program:", stakeProgramId.toBase58());
    console.log("Vault Token Account (e.g. wYLDS)", vaultTokenAccount.toBase58());
    console.log("Stake Config PDA:", stakeConfigPda.toBase58());
    console.log("Mint Config PDA:", mintConfigPda.toBase58());
    console.log("Rewards Mint Authority PDA:", rewardsMintAuthorityPda.toBase58());
    console.log("Vault Authority PDA:", vaultAuthorityPda.toBase58());

    const tx = await program.methods
        .publishRewards(amount)
        .accountsStrict({
            stakeConfig: stakeConfigPda,
            mintConfig: mintConfigPda,
            externalMintAuthority: externalMintAuthorityPda,
            mintProgram: new anchor.web3.PublicKey(args.mint_program),
            admin: signer,
            rewardsMint: rewardsMint,
            rewardsMintAuthority: rewardsMintAuthorityPda,
            vaultTokenAccount: vaultTokenAccount,
            vaultAuthority: vaultAuthorityPda,
            tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID
        }).rpc();

    console.log("Transaction:", tx);
};

main().catch(console.error);



