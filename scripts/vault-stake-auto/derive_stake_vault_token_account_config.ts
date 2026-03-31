import * as anchor from "@coral-xyz/anchor";
import yargs from "yargs";
import {PublicKey} from "@solana/web3.js";

const args = yargs(process.argv.slice(2))
    .option("program_id", {
      type: "string",
      description: "Program ID",
      required: true,
    })
    .parseSync();

const main = async () => {

    const programId = new anchor.web3.PublicKey(args.program_id);
    const [stakeConfigPda] = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("stake_config")],
        programId
    )
    const [stakeVaultTokenAccountConfigPda] = PublicKey.findProgramAddressSync(
        [
            Buffer.from("stake_vault_token_account_config"),
            stakeConfigPda.toBuffer()
        ],
        programId
    );
    console.log(stakeVaultTokenAccountConfigPda.toBase58());
}

main().catch(console.error);



