import * as anchor from "@coral-xyz/anchor";
import {Program} from "@coral-xyz/anchor";
import {VaultMint} from "../../target/types/vault_mint";
import {PublicKey} from "@solana/web3.js";
import yargs from "yargs";

const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);

const program = anchor.workspace.VaultMint as Program<VaultMint>;

const args = yargs(process.argv.slice(2))
    .option("new_vault_token_account", {
        type: "string",
        description: "New vault token account",
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

    const newVaultTokenAccount = new PublicKey(args.new_vault_token_account);
    console.log("Config PDA:", configPda.toBase58());
    console.log("ProgramData PDA:", programData.toBase58());
    console.log("New Vault Token Account:", newVaultTokenAccount.toBase58());

    const tx = await program.methods
        .updateVaultTokenAccount()
        .accountsStrict({
            config: configPda,
            signer: provider.wallet.publicKey,
            vaultTokenAccount: newVaultTokenAccount,
            programData: programData,
        })
        .rpc();

    console.log("Transaction:", tx);
};

main().catch(console.error); 
