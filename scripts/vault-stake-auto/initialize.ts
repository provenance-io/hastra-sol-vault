import * as anchor from "@coral-xyz/anchor";
import {Program} from "@coral-xyz/anchor";
import {VaultStakeAuto} from "../../target/types/vault_stake_auto";
import yargs from "yargs";
import {PublicKey} from "@solana/web3.js";

const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);

const program = anchor.workspace.VaultStakeAuto as Program<VaultStakeAuto>;

const args = yargs(process.argv.slice(2))
    .option("vault", {
        type: "string",
        description: "Vaulted token mint accepted for stake (e.g. wYLDS)",
        required: true,
    })
    .option("mint", {
        type: "string",
        description: "Staking share mint minted to users (e.g. AUTO)",
        required: true,
    })
    .option("vault_token_account", {
        type: "string",
        description:
            "Pool ATA for vaulted token (wYLDS). Must be owned by the vault authority PDA after setup.",
        required: true,
    })
    .option("freeze_administrators", {
        type: "string",
        description: "Comma separated list of administrator public keys that can freeze user accounts",
        required: true,
    })
    .option("rewards_administrators", {
        type: "string",
        description: "Comma separated list of administrator public keys that can execute user staking distribution rewards.",
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

    // bpf_loader_upgradeable program id
    const BPF_LOADER_UPGRADEABLE_ID = new PublicKey(
        "BPFLoaderUpgradeab1e11111111111111111111111"
    );
    // derive ProgramData PDA
    const [programData] = PublicKey.findProgramAddressSync(
        [program.programId.toBuffer()],
        BPF_LOADER_UPGRADEABLE_ID
    );

    const [vaultAuthorityPda] = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("vault_authority")],
        program.programId
    );
    const [mintAuthorityPda] = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("mint_authority")],
        program.programId
    );
    const [freezeAuthorityPda] = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("freeze_authority")],
        program.programId
    );
    const vault = new anchor.web3.PublicKey(args.vault);
    const mint = new anchor.web3.PublicKey(args.mint);
    const vaultTokenAccount = new anchor.web3.PublicKey(args.vault_token_account);
    const freezeAdministrators: PublicKey[] = (args.freeze_administrators.split(",")).map((s: string) => new anchor.web3.PublicKey(s));
    if (freezeAdministrators.length > 5) {
        throw new Error(`Number of freeze administrators (${freezeAdministrators.length}) exceeds maximum 5`);
    }
    const rewardsAdministrators: PublicKey[] = (args.rewards_administrators.split(",")).map((s: string) => new anchor.web3.PublicKey(s));
    if (rewardsAdministrators.length > 5) {
        throw new Error(`Number of rewards administrators (${rewardsAdministrators.length}) exceeds maximum 5`);
    }

    console.log("Program ID:", program.programId.toBase58());
    console.log("Vault (e.g. wYLDS):", vault.toBase58());
    console.log("Mint (e.g. AUTO):", mint.toBase58());
    console.log("Vault Token Account:", vaultTokenAccount.toBase58());
    console.log("Stake Config PDA:", stakeConfigPda.toBase58());
    console.log("Stake Vault Token Account Config PDA:", stakeVaultTokenAccountConfigPda.toBase58());
    console.log("Vault Authority PDA:", vaultAuthorityPda.toBase58());
    console.log("Mint Authority PDA:", mintAuthorityPda.toBase58());
    console.log("Freeze Authority PDA:", freezeAuthorityPda.toBase58());
    console.log("Freeze Administrators:", freezeAdministrators.map((a) => a.toBase58()));
    console.log("Rewards Administrators:", rewardsAdministrators.map((a) => a.toBase58()));
    console.log("Program Data PDA:", programData.toBase58());

    // Call initialize
    await program.methods
        .initialize(freezeAdministrators, rewardsAdministrators)
        .accountsStrict({
            stakeConfig: stakeConfigPda,
            vaultAuthority: vaultAuthorityPda,
            vaultTokenAccount: vaultTokenAccount,
            stakeVaultTokenAccountConfig: stakeVaultTokenAccountConfigPda,
            vaultTokenMint: vault,
            mint: mint,
            signer: provider.wallet.publicKey,
            tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
            systemProgram: anchor.web3.SystemProgram.programId,
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
