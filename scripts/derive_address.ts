import * as anchor from "@coral-xyz/anchor";
import yargs from "yargs";
import {getAssociatedTokenAddress} from "@solana/spl-token";
import {PublicKey} from "@solana/web3.js";

const args = yargs(process.argv.slice(2))
    .option("type", {
      type: "string",
      description: "Type of address: ata, pda",
      required: true,
    })
    .option("mint", {
      type: "string",
      description: "Token mint",
      required: false,
    })
    .option("public_key", {
        type: "string",
        description: "Public key for ATA derivation",
        required: false,
    })
    .option("program_id", {
      type: "string",
      description: "Program ID",
      required: false,
    })
    .option("seed", {
      type: "string",
      description: "Seed for PDA",
      required: false,
    })
    .parseSync();

const main = async () => {

  if(args.type === "pda") {
    if(args.program_id === undefined) {
      throw new Error("Program ID must be provided for ATA derivation")
    }
    const [pda] = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from(args.seed)],
        new anchor.web3.PublicKey(args.program_id)
    )
    console.log(pda.toBase58());
  }

  if(args.type === "ata") {
    if(args.mint === undefined) {
      throw new Error("Mint must be provided for ATA derivation")
    }
    if(args.public_key === undefined) {
        throw new Error("Public key must be provided for ATA derivation")
    }
    const mint = new anchor.web3.PublicKey(args.mint);
    const pk = new anchor.web3.PublicKey(args.public_key);

    const ata: PublicKey = await getAssociatedTokenAddress(
        mint,
        pk
    );
    console.log(ata.toBase58());
  }
};

main().catch(console.error);



