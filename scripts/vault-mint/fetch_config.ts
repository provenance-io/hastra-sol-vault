import * as anchor from "@coral-xyz/anchor";
import {Program} from "@coral-xyz/anchor";
import {VaultMint} from "../../target/types/vault_mint";
import {PublicKey,} from "@solana/web3.js";

const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);

const program = anchor.workspace.VaultMint as Program<VaultMint>;

const main = async () => {
    const [configPda] = anchor.web3.PublicKey.findProgramAddressSync(
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

    const [allowedExternalMintProgramsPda] = PublicKey.findProgramAddressSync(
        [
            Buffer.from("allowed_external_mint_programs"),
            configPda.toBuffer(),
        ],
        program.programId
    );

    console.log("Program ID:                            ", program.programId.toBase58());
    console.log("Config PDA:                            ", configPda.toBase58());
    console.log("Vault Token Account Config PDA:        ", vaultTokenAccountConfigPda.toBase58());
    console.log("Allowed External Mint Programs PDA:    ", allowedExternalMintProgramsPda.toBase58());

    const config = await program.account.config.fetch(configPda);
    console.log("Vault Mint:                            ", config.vault.toBase58());
    console.log("Mint:                                  ", config.mint.toBase58());
    console.log("Freeze Administrators:                 ", config.freezeAdministrators.map(a => a.toBase58()).join(", "));
    console.log("Rewards Administrators:                ", config.rewardsAdministrators.map(a => a.toBase58()).join(", "));
    console.log("Vault Authority:                       ", config.vaultAuthority.toBase58());
    console.log("Paused:                                ", config.paused);
    console.log("Allowed External Mint Program:         ", config.allowedExternalMintProgram.toBase58());

    const allowedInfo = await provider.connection.getAccountInfo(allowedExternalMintProgramsPda);
    if (!allowedInfo || allowedInfo.data.length < 8) {
        console.log("Allowed External Mint Programs (ext):  (account not allocated yet)");
    } else {
        try {
            const allowed = await program.account.allowedExternalMintPrograms.fetch(
                allowedExternalMintProgramsPda
            );
            console.log("Allowed External Mint Programs (ext):  bump=", allowed.bump);
            if (allowed.programs.length === 0) {
                console.log("                                       (empty list)");
            } else {
                for (const p of allowed.programs) {
                    console.log("                                       ", p.toBase58());
                }
            }
        } catch (e) {
            console.log("Allowed External Mint Programs (ext):  (failed to decode)", e);
        }
    }

    const vaultTokenAccountConfig = await program.account.vaultTokenAccountConfig.fetch(vaultTokenAccountConfigPda);
    console.log("Vault Token Account:                   ", vaultTokenAccountConfig.vaultTokenAccount.toBase58());
};

main().catch(console.error);
