import * as anchor from "@coral-xyz/anchor";
import yargs from "yargs";
import {getAssociatedTokenAddress} from "@solana/spl-token";
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
    const [configPda] = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("config")],
        programId
    )
    const [vaultTokenAccountConfigPda] = PublicKey.findProgramAddressSync(
        [
            Buffer.from("vault_token_account_config"),
            configPda.toBuffer()
        ],
        programId
    );
    console.log(vaultTokenAccountConfigPda.toBase58());
}

main().catch(console.error);



