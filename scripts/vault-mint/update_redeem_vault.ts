import * as anchor from "@coral-xyz/anchor";
import {Program} from "@coral-xyz/anchor";
import {VaultMint} from "../../target/types/vault_mint";
import {PublicKey} from "@solana/web3.js";
import yargs from "yargs";

/**
 * Sets config.redeem_vault to a PDA-owned vault-mint token account.
 * Required once after upgrade on deployments that initialized before this field was written.
 * Signer must be the program upgrade authority.
 *
 * For Squads-controlled upgrade authority use:
 *   scripts/vault-mint/update_redeem_vault_proposal_squads.ts
 */

const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);

const program = anchor.workspace.VaultMint as Program<VaultMint>;

const args = yargs(process.argv.slice(2))
    .option("redeem_vault_token_account", {
        type: "string",
        description: "PDA-owned redeem vault token account to pin as config.redeem_vault",
        required: true,
    })
    .parseSync();

const main = async () => {
    const [configPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("config")],
        program.programId
    );
    const BPF_LOADER_UPGRADEABLE_ID = new PublicKey(
        "BPFLoaderUpgradeab1e11111111111111111111111"
    );
    const [programData] = PublicKey.findProgramAddressSync(
        [program.programId.toBuffer()],
        BPF_LOADER_UPGRADEABLE_ID
    );
    const [redeemVaultAuthorityPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("redeem_vault_authority")],
        program.programId
    );
    const redeemVaultTokenAccount = new PublicKey(args.redeem_vault_token_account);

    console.log("Config PDA:", configPda.toBase58());
    console.log("Redeem Vault Authority:", redeemVaultAuthorityPda.toBase58());
    console.log("Redeem Vault Token Account:", redeemVaultTokenAccount.toBase58());

    const tx = await program.methods
        .updateRedeemVault()
        .accountsStrict({
            config: configPda,
            redeemVaultAuthority: redeemVaultAuthorityPda,
            redeemVaultTokenAccount: redeemVaultTokenAccount,
            programData: programData,
            signer: provider.wallet.publicKey,
        })
        .rpc();

    console.log("Transaction:", tx);
    const config = await program.account.config.fetch(configPda);
    console.log("config.redeem_vault:", config.redeemVault.toBase58());
};

main().catch(console.error);
