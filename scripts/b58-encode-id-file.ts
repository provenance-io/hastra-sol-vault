import yargs from "yargs";
import bs58 from "bs58";
import * as fs from "node:fs";
import {Keypair} from "@solana/web3.js";

const args = yargs(process.argv.slice(2))
    .option("keypair", {
        type: "string",
        description: "Path to keypair file",
        required: true,
    })
    .parseSync();

const main = async () => {
    // Read file
    const raw = fs.readFileSync(args.keypair, "utf8");

    // Parse array of integers
    const arr: number[] = JSON.parse(raw);

    // Convert to Uint8Array
    const secretKey = Uint8Array.from(arr);

    // get the public key for the secret key

    const keypair = Keypair.fromSecretKey(secretKey)
    console.log(keypair.publicKey.toBase58());
    console.log(bs58.encode(secretKey));
};

main().catch(console.error);
