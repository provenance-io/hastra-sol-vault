import * as anchor from "@coral-xyz/anchor";
import {Program} from "@coral-xyz/anchor";
import {VaultMint} from "../../target/types/vault_mint";
import {PublicKey,} from "@solana/web3.js";

const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);

const program = anchor.workspace.VaultMint as Program<VaultMint>;

const main = async () => {
    const [configPda, bump] = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("config")],
        program.programId
    );
    const [vaultTokenAccountConfigPda] = PublicKey.findProgramAddressSync(
        [
            Buffer.from("vault_token_account_config"),
            configPda.toBuffer()
        ],
        program.programId
    );

    console.log("Program ID:                            ", program.programId.toBase58());
    console.log("Config PDA:                            ", configPda.toBase58());
    console.log("Vault Token Account Config PDA:        ", vaultTokenAccountConfigPda.toBase58());

    const config = await program.account.config.fetch(configPda);
    console.log("Vault Mint:                            ", config.vault.toBase58());
    console.log("Vault Token Owner:                     ", config.vaultAuthority.toBase58());

    const vaultTokenAccountConfig = await program.account.vaultTokenAccountConfig.fetch(vaultTokenAccountConfigPda);
    console.log("Vault Token Account:                   ", vaultTokenAccountConfig.vaultTokenAccount.toBase58());
};

main().catch(console.error);
