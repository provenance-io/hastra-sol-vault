import {createUmi} from "@metaplex-foundation/umi-bundle-defaults";
import {
    createSignerFromKeypair,
    publicKey,
    signerIdentity,
    some,
} from "@metaplex-foundation/umi";
import {
    fetchMetadataFromSeeds,
    updateV1,
} from "@metaplex-foundation/mpl-token-metadata";
import * as anchor from "@coral-xyz/anchor";
import yargs from "yargs";

/**
 * Transfers Metaplex token-metadata update authority for a mint.
 * The wallet (ANCHOR_WALLET) must be the current update authority.
 * Prefer the Squads vault PDA as --new_update_authority (not the multisig account).
 */
const provider = anchor.AnchorProvider.env();

const args = yargs(process.argv.slice(2))
    .option("mint", {
        type: "string",
        description: "SPL mint whose Metaplex metadata update authority will change",
        required: true,
    })
    .option("new_update_authority", {
        type: "string",
        description:
            "New Metaplex update authority (use the Squads vault PDA, not the multisig account)",
        required: true,
    })
    .parseSync();

const umi = createUmi(provider.connection.rpcEndpoint);
const keypair = umi.eddsa.createKeypairFromSecretKey(provider.wallet.payer.secretKey);
const signer = createSignerFromKeypair(umi, keypair);
umi.use(signerIdentity(signer));

const mint = publicKey(args.mint);
const newUpdateAuthority = publicKey(args.new_update_authority);

async function main() {
    const metadata = await fetchMetadataFromSeeds(umi, {mint});
    console.log(`Mint:                                  ${args.mint}`);
    console.log(`Metadata update authority (current):   ${metadata.updateAuthority}`);
    console.log(`Signer (must match current):           ${signer.publicKey}`);
    console.log(`New update authority:                  ${newUpdateAuthority}`);
    console.log(`RPC:                                   ${provider.connection.rpcEndpoint}`);

    if (metadata.updateAuthority !== signer.publicKey) {
        throw new Error(
            `Wallet ${signer.publicKey} is not the current update authority (${metadata.updateAuthority})`
        );
    }

    const tx = await updateV1(umi, {
        mint,
        authority: signer,
        newUpdateAuthority: some(newUpdateAuthority),
    }).sendAndConfirm(umi);

    console.log("Transaction Result:", JSON.stringify(tx));

    const updated = await fetchMetadataFromSeeds(umi, {mint});
    console.log(`Update authority after transfer:       ${updated.updateAuthority}`);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
