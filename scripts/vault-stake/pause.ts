import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { VaultStake } from "../../target/types/vault_stake";
import yargs from "yargs";

const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);

const workspaceProgram = anchor.workspace.VaultStake as Program<VaultStake>;

const args = yargs(process.argv.slice(2))
    .option("pause", {
        type: "boolean",
        description: "Set to true to pause the program, false to unpause",
        required: true,
    })
    .option("program_id", {
        type: "string",
        description: "Optional vault-stake program id override (AUTO / SMB)",
    })
    .parseSync();

const main = async () => {
    const resolvedIdl = JSON.parse(JSON.stringify(workspaceProgram.idl));
    if (args.program_id) {
        new PublicKey(args.program_id);
        resolvedIdl.address = args.program_id;
        if (resolvedIdl.metadata) {
            resolvedIdl.metadata.address = args.program_id;
        }
    }
    const program = new anchor.Program(resolvedIdl as anchor.Idl, provider) as Program<VaultStake>;

    const [stakeConfigPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("stake_config")],
        program.programId
    );

    console.log("Program ID:", program.programId.toBase58());
    console.log("Stake Config PDA:", stakeConfigPda.toBase58());

    await program.methods
        .pause(args.pause)
        .accountsStrict({
            stakeConfig: stakeConfigPda,
            signer: provider.wallet.publicKey,
        })
        .rpc()
        .then((tx) => {
            console.log("Transaction:", tx);
        })
        .catch((err) => {
            if (err.getLogs) {
                console.dir(err.getLogs);
            }
            console.error("Transaction failed:", err);
            throw err;
        });
};

main().catch(console.error);
