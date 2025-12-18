import * as anchor from "@coral-xyz/anchor";
import {Program} from "@coral-xyz/anchor";
import {VaultStake} from "../../target/types/vault_stake";
import {PublicKey,} from "@solana/web3.js";

const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);

const program = anchor.workspace.VaultStake as Program<VaultStake>;

const main = async () => {
    const [stakeConfigPda, bump] = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("stake_config")],
        program.programId
    );
    const [stakeVaultTokenAccountConfigPda] = PublicKey.findProgramAddressSync(
        [
            Buffer.from("stake_vault_token_account_config"),
            stakeConfigPda.toBuffer()
        ],
        program.programId
    );

    console.log("Program ID:                            ", program.programId.toBase58());
    console.log("Config PDA:                            ", stakeConfigPda.toBase58());
    console.log("Vault Token Account Config PDA:        ", stakeVaultTokenAccountConfigPda.toBase58());

    const config = await program.account.stakeConfig.fetch(stakeConfigPda);
    console.log("Mint:                                  ", config.mint.toBase58());
    console.log("Vault Mint:                            ", config.vault.toBase58());
    console.log("Unbonding Period:                      ", config.unbondingPeriod.toString());
    console.log("Freeze Admins:                         ", config.freezeAdministrators.map(a => a.toBase58()).join(", "));
    console.log("Rewards Admins:                        ", config.rewardsAdministrators.map(a => a.toBase58()).join(", "));
    console.log("Paused:                                ", config.paused.toString());

    const stakeVaultTokenAccountConfig = await program.account.stakeVaultTokenAccountConfig.fetch(stakeVaultTokenAccountConfigPda);
    console.log("Vault Token Account:                   ", stakeVaultTokenAccountConfig.vaultTokenAccount.toBase58());
    console.log("Vault Authority:                       ", stakeVaultTokenAccountConfig.vaultAuthority.toBase58());
};

main().catch(console.error);
