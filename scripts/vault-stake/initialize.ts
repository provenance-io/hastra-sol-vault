import * as anchor from "@coral-xyz/anchor";
import {Program} from "@coral-xyz/anchor";
import {VaultStake} from "../../target/types/vault_stake";
import yargs from "yargs";
import BN from "bn.js";
import {
    PublicKey,
    sendAndConfirmTransaction,
    Transaction
} from "@solana/web3.js";

const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);

const program = anchor.workspace.VaultStake as Program<VaultStake>;

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
    .option("unbonding_period", {
        type: "string",
        description: "Unbonding period in seconds",
        required: true,
    })
    .option("vault_token_account", {
        type: "string",
        description: "Token account that will hold the vaulted asset (e.g. wYLDS). Must be owned by the program-derived address.",
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
    const [stakeConfigPda, bump] = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("stake_config")],
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
    const unbondingPeriod = new BN(parseInt(args.unbonding_period));
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
    console.log("Vault (accepted token):", vault.toBase58());
    console.log("Mint (token to be minted):", mint.toBase58());
    console.log("Unbonding Period (seconds):", unbondingPeriod);
    console.log("Vault Token Account:", vaultTokenAccount.toBase58());
    console.log("Stake Config PDA:", stakeConfigPda.toBase58());
    console.log("Vault Authority PDA:", vaultAuthorityPda.toBase58());
    console.log("Mint Authority PDA:", mintAuthorityPda.toBase58());
    console.log("Freeze Authority PDA:", freezeAuthorityPda.toBase58());
    console.log("Freeze Administrators:", freezeAdministrators.map((a) => a.toBase58()));
    console.log("Rewards Administrators:", rewardsAdministrators.map((a) => a.toBase58()));
    console.log("Program Data PDA:", programData.toBase58());

    // Call initialize
    await program.methods
        .initialize(unbondingPeriod, freezeAdministrators, rewardsAdministrators)
        .accounts({
            signer: provider.wallet.publicKey,
            vaultTokenAccount: vaultTokenAccount,
            vaultTokenMint: vault,
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
