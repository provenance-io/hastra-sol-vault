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
    .option("pause", {
        type: "boolean",
        description: "Set to true to pause the program, false to unpause",
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

    console.log("Program ID:", program.programId.toBase58());
    console.log("Stake Config PDA:", stakeConfigPda.toBase58());

    // Call initialize
    await program.methods
        .pause(args.pause)
        .accounts({
            programData: programData,
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
