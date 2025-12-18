import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { VaultStake } from "../../target/types/vault_stake";
import yargs from "yargs";
import {
    PublicKey,
} from "@solana/web3.js";

const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);

const program = anchor.workspace.VaultStake as Program<VaultStake>;

const args = yargs(process.argv.slice(2))
    .option("vault_token_account", {
        type: "string",
        description: "Public key of the specific vault token account to configure.",
        required: true,
    })
    .parseSync();

const main = async () => {
    const [stakeConfigPda] = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("stake_config")],
        program.programId
    );

    const [stakeVaultTokenAccountConfigPda] = anchor.web3.PublicKey.findProgramAddressSync(
        [
            Buffer.from("stake_vault_token_account_config"),
            stakeConfigPda.toBuffer()
        ],
        program.programId
    );

    const [vaultAuthorityPda] = anchor.web3.PublicKey.findProgramAddressSync(
        [
            Buffer.from("vault_authority"),
        ],
        program.programId
    )
    // bpf_loader_upgradeable program id
    const BPF_LOADER_UPGRADEABLE_ID = new PublicKey(
        "BPFLoaderUpgradeab1e11111111111111111111111"
    );
    // derive ProgramData PDA
    const [programData] = PublicKey.findProgramAddressSync(
        [program.programId.toBuffer()],
        BPF_LOADER_UPGRADEABLE_ID
    );

    const vaultTokenAccount = new PublicKey(args.vault_token_account);
    console.log("Program ID:", program.programId.toBase58());
    console.log("Stake Config PDA:", stakeConfigPda.toBase58());
    console.log("Stake Vault Token Account Config PDA:", stakeVaultTokenAccountConfigPda.toBase58());
    console.log("Vault Token Account:", vaultTokenAccount.toBase58());
    console.log("Vault Authority:", vaultAuthorityPda.toBase58());

    // Call initialize
    await program.methods
        .setStakeVaultTokenAccountConfig()
        .accountsStrict({
            stakeConfig: stakeConfigPda,
            vaultAuthority: vaultAuthorityPda,
            vaultTokenAccount: vaultTokenAccount,
            stakeVaultTokenAccountConfig: stakeVaultTokenAccountConfigPda,
            signer: provider.wallet.publicKey,
            programData: programData,
            systemProgram: anchor.web3.SystemProgram.programId,
        })
        .rpc()
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
