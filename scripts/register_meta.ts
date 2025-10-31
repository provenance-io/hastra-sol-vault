import {createUmi} from "@metaplex-foundation/umi-bundle-defaults";
import {
    createSignerFromKeypair,
    None,
    percentAmount,
    publicKey,
    signerIdentity,
    Some
} from "@metaplex-foundation/umi";
import {
    createV1,
    Creator,
    fetchMetadata,
    TokenStandard,
    updateV1
} from "@metaplex-foundation/mpl-token-metadata";
import * as anchor from "@coral-xyz/anchor";
import yargs from "yargs";

const provider = anchor.AnchorProvider.env();

const args = yargs(process.argv.slice(2))
    .option("mint", {
        type: "string",
        description: "Token that will be minted upon receipt of the vaulted asset",
        required: true,
    })
    .option("name", {
        type: "string",
        description: "The name of the token (.e.g. wYLDS)",
        required: true,
    })
    .option("symbol", {
        type: "string",
        description: "The name of the token (.e.g. wYLDS)",
        required: true,
    })
    .option("token_meta_url", {
        type: "string",
        description: "The public location of the token metadata json file (.e.g. https://storage.googleapis.com/hastra-cdn-prod/spl/wylds.meta.json)",
        required: true,
    })
    .option("update", {
        type: "boolean",
        description: "Set to true to update existing metadata account",
        required: false,
        default: false,
    })
    .parseSync();

// Init umi
const umi = createUmi(provider.connection.rpcEndpoint);

// Signer for the mint
const keypair = umi.eddsa.createKeypairFromSecretKey(provider.wallet.payer.secretKey);
const signer = createSignerFromKeypair(umi, keypair);

const mintPublicKey = new anchor.web3.PublicKey(args.mint);

console.log(`Using mint ${mintPublicKey.toBase58()} current key owner: ${signer.publicKey}`);
console.log(`Using token name: ${args.name}`);
console.log(`Using token symbol: ${args.symbol}`);
console.log(`Using token meta_url: ${args.token_meta_url}`);
console.log(`Using Solana RPC: ${provider.connection.rpcEndpoint}`);

// Set the signer identity on the Umi instance
umi.use(signerIdentity(signer));

if(args.update) {
    // Minimal update: change just the URI (and/or name/symbol).
    // Fetch metadata account
    fetchMetadata(umi, args.mint).then(metadata => {
        const creators: Some<Array<Creator>> | None = metadata.creators ?? null;
        console.dir(creators);
        updateV1(umi, {
            mint: publicKey(args.mint),
            authority: signer,
            data: {
                name: args.name,              // keep same as before if not changing
                symbol: args.symbol,          // keep same as before if not changing
                uri: args.token_meta_url,     // <-- new metadata JSON URL
                sellerFeeBasisPoints: 0,
                creators: [
                    {
                        "address": keypair.publicKey,
                        "verified": true,
                        "share": 100
                    }
                ]
            },
        }).sendAndConfirm(umi).then(tx => {
            console.log("Transaction Result:", JSON.stringify(tx));
        }).catch(err => {
            console.error("Transaction Error:", err);
        });
    }).catch(err => {
        console.error("Error fetching metadata:", err);
    });

    // The creators array (may be undefined if none were set)
} else {
    createV1(umi, {
        mint: publicKey(args.mint),
        authority: signer,
        name: args.ame,
        symbol: args.symbol,
        uri: args.token_meta_url,
        isMutable: true,
        sellerFeeBasisPoints: percentAmount(0),
        tokenStandard: TokenStandard.Fungible,
        decimals: 6,
    }).sendAndConfirm(umi).then(tx => {
        console.log("Transaction Result:", JSON.stringify(tx));
    }).catch(err => {
        console.error("Transaction Error:", err);
    });
}
