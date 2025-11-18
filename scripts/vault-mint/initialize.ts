import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { VaultMint } from "../../target/types/vault_mint";
import yargs from "yargs";
import {
    PublicKey,
} from "@solana/web3.js";

const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);

const program = anchor.workspace.VaultMint as Program<VaultMint>;

const args = yargs(process.argv.slice(2))
    .option("vault", {
        type: "string",
        description: "Token that will be accepted in exchange for the minted token",
        required: true,
    })
    .option("mint", {
        type: "string",
        description: "Token that will be minted upon receipt of the vaulted asset",
        required: true,
    })
    .option("vault_token_account", {
        type: "string",
        description: "Token account that will hold the vaulted asset (e.g. USDC).",
        required: true,
    })
    .option("redeem_vault_token_account", {
        type: "string",
        description: "Token account that will hold vaulted asset (e.g. USDC) used for redemptions.",
        required: true,
    })
    .option("freeze_administrators", {
        type: "string",
        description: "Comma separated list of administrator public keys that can freeze user accounts",
        required: true,
    })
    .option("rewards_administrators", {
        type: "string",
        description: "Comma separated list of administrator public keys that can execute user distribution rewards.",
        required: true,
    })
    .option("allow_mint_program_caller_id", {
        type: "string",
        description: "Allowed program caller id for minting",
        required: true,
    })
    .parseSync();

const main = async () => {
    const [configPda, bump] = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("config")],
        program.programId
    );
    // bpf_loader_upgradeable program id
    const BPF_LOADER_UPGRADEABLE_ID = new PublicKey(
        "BPFLoaderUpgradeab1e11111111111111111111111"
    );
    // derive ProgramData PDA
    const [programData] = PublicKey.findProgramAddressSync(
        [program.programId.toBuffer()],
        BPF_LOADER_UPGRADEABLE_ID
    );

    const [mintAuthorityPda] = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("mint_authority")],
        program.programId
    );
    const [freezeAuthorityPda] = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("freeze_authority")],
        program.programId
    );

    const [redeemVaultAuthorityPda] = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("redeem_vault_authority")],
        program.programId
    );

    const vault = new anchor.web3.PublicKey(args.vault);
    const mint = new anchor.web3.PublicKey(args.mint);
    const vaultTokenAccount = new anchor.web3.PublicKey(args.vault_token_account);
    const redeemVaultTokenAccount = new anchor.web3.PublicKey(args.redeem_vault_token_account);

    const freezeAdministrators: PublicKey[] = (args.freeze_administrators.split(",")).map((s: string) => new anchor.web3.PublicKey(s));
    if (freezeAdministrators.length > 5) {
        throw new Error(`Number of freeze administrators (${freezeAdministrators.length}) exceeds maximum 5`);
    }
    const rewardsAdministrators: PublicKey[] = (args.rewards_administrators.split(",")).map((s: string) => new anchor.web3.PublicKey(s));
    if (rewardsAdministrators.length > 5) {
        throw new Error(`Number of rewards administrators (${rewardsAdministrators.length}) exceeds maximum 5`);
    }

    const allowedMintProgramId = new PublicKey(args.allow_mint_program_caller_id);

    console.log("Program ID:", program.programId.toBase58());
    console.log("Vault (accepted token):", vault.toBase58());
    console.log("Mint (token to be minted):", mint.toBase58());
    console.log("Vault Token Account:", vaultTokenAccount.toBase58());
    console.log("Config PDA:", configPda.toBase58());
    console.log("Mint Authority PDA:", mintAuthorityPda.toBase58());
    console.log("Freeze Authority PDA:", freezeAuthorityPda.toBase58());
    console.log("Freeze Administrators:", freezeAdministrators.map((a) => a.toBase58()));
    console.log("Allowed Mint Program ID:", allowedMintProgramId.toBase58());
    console.log("Rewards Administrators:", rewardsAdministrators.map((a) => a.toBase58()));
    console.log("Redeem Vault Token Account:", redeemVaultTokenAccount.toBase58());
    console.log("Redeem Vault Authority PDA:", redeemVaultAuthorityPda.toBase58());
    console.log("Program Data PDA:", programData.toBase58());

    // Call initialize
    await program.methods
        .initialize(freezeAdministrators, rewardsAdministrators)
        .accounts({
            signer: provider.wallet.publicKey,
            vaultTokenAccount: vaultTokenAccount,
            vaultTokenMint: vault,
            allowedExternalMintProgram: allowedMintProgramId,
            redeemVaultTokenAccount: redeemVaultTokenAccount,
            mint: mint,
            programData: programData,
        }).rpc()
        .then((tx) => {
            console.log("Transaction:", tx);
        })
        .catch(
            (err) => {
                if (err.getLogs) {
                    console.dir(err.getLogs);
                }
                console.error("Transaction failed:", err);
                throw err;
            }
        )
};

main().catch(console.error);
