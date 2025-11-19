import * as anchor from "@coral-xyz/anchor";
import {Program} from "@coral-xyz/anchor";
import {VaultMint} from "../../target/types/vault_mint";
import {PublicKey} from "@solana/web3.js";
import yargs from "yargs";
import {TOKEN_PROGRAM_ID} from "@solana/spl-token";

const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);

const program = anchor.workspace.VaultMint as Program<VaultMint>;

const args = yargs(process.argv.slice(2))
    .option("amount",{
        type: "number",
        description: "Amount of tokens to transfer from the redeem vault",
        required: true,
    })
    .option("redeem_vault_token_account", {
        type: "string",
        description: "Current redeem vault token account",
        required: true,
    })
    .option("destination_token_account", {
        type: "string",
        description: "Account that will receive the redemption vault tokens",
        required: true,
    })
    .parseSync();

const main = async () => {
    const [configPda, bump] = PublicKey.findProgramAddressSync([
        Buffer.from("config")
    ], program.programId);

    // bpf_loader_upgradeable program id
    const BPF_LOADER_UPGRADEABLE_ID = new PublicKey(
        "BPFLoaderUpgradeab1e11111111111111111111111"
    );
    // derive ProgramData PDA
    const [programData] = PublicKey.findProgramAddressSync(
        [program.programId.toBuffer()],
        BPF_LOADER_UPGRADEABLE_ID
    );
    const [redeemVaultAuthorityPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("redeem_vault_authority")],
        program.programId
    );
    const redeemVaultTokenAccount = new PublicKey(args.redeem_vault_token_account);
    const destinationTokenAccount = new PublicKey(args.destination_token_account);
    console.log("Amount to transfer:", args.amount);
    console.log("Redeem Vault Authority PDA:", redeemVaultAuthorityPda.toBase58());
    console.log("Config PDA:", configPda.toBase58());
    console.log("ProgramData PDA:", programData.toBase58());
    console.log("Destination Token Account:", destinationTokenAccount.toBase58());

    const tx = await program.methods
        .sweepRedeemVaultFunds(new anchor.BN(args.amount))
        .accountsStrict({
            config: configPda,
            signer: provider.wallet.publicKey,
            redeemVaultAuthority: redeemVaultAuthorityPda,
            redeemVaultTokenAccount: redeemVaultTokenAccount,
            destinationTokenAccount: destinationTokenAccount,
            programData: programData,
            tokenProgram: TOKEN_PROGRAM_ID
        })
        .rpc();

    console.log("Transaction:", tx);
};

main().catch(console.error); 
