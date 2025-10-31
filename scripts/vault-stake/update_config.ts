import * as anchor from "@coral-xyz/anchor";
import {Program} from "@coral-xyz/anchor";
import {VaultStake} from "../../target/types/vault_stake";
import yargs from "yargs";
import {PublicKey} from "@solana/web3.js";
import {
    TOKEN_PROGRAM_ID,
} from "@solana/spl-token";

const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);

const program = anchor.workspace.VaultStake as Program<VaultStake>;

const args = yargs(process.argv.slice(2))
    .option("unbonding_period", {
        type: "number",
        description: "Unbonding period in seconds",
        required: true,
    })
    .parseSync();

const main = async () => {
    const signer = provider.wallet.publicKey;

    // Create PDA (if needed)
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

    const unbondingPeriod = new anchor.BN(args.unbonding_period);

    console.log("Calling function:", "updateConfig");
    console.log("Available methods:", Object.keys(program.methods));
    // Print the accounts for your specific method
    console.log("IDL accounts for updateConfig:",
        program.idl.instructions.find(ix => ix.name === "updateConfig")?.accounts
    );

    console.log("Stake Config PDA:", stakeConfigPda.toBase58());
    console.log("Unbonding Period:", unbondingPeriod.toString());
    console.log("ProgramData PDA:", programData.toBase58());
    console.log("Signer:", signer.toBase58());
    console.log("Token Program:", TOKEN_PROGRAM_ID.toBase58());

    try {
        const tx = await program.methods
            .updateConfig(unbondingPeriod)
            .accounts({
                signer: signer,
                programData: programData,
            })
            .rpc();
        console.log("Transaction:", tx);
    } catch (error) {
        throw error;
    }


};

main().catch(console.error);
