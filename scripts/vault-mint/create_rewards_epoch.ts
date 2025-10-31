import * as anchor from "@coral-xyz/anchor";
import {Program} from "@coral-xyz/anchor";
import {VaultMint} from "../../target/types/vault_mint";
import {PublicKey} from "@solana/web3.js";
import yargs from "yargs";
import {
    allocationsToMerkleTree,
    idl,
} from "../cryptolib";
const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);

const program: Program<VaultMint> = new anchor.Program(idl as anchor.Idl, provider) as Program<VaultMint>;

const args = yargs(process.argv.slice(2))
    .option("epoch", {
        type: "number",
        description: "Epoch index",
        required: true,
    })
    .option("reward_allocations", {
        type: "json",
        description: "Allocations object: {allocations: [{\"account\": \"3m7...sKf\", \"amount\": 1000}, ...]}",
        required: true,
    })
    .option("just_print", {
        type: "boolean",
        description: "If true, just print the leaves and root without creating the epoch on-chain",
        required: false,
        default: false,
    })
    .parseSync();

const main = async () => {
    const epochIndex = args.epoch;
    const { tree, leaves, allocations } = allocationsToMerkleTree(args.reward_allocations, epochIndex);
    const root = tree.getRoot();

    if (args.just_print) {
        const leaf = leaves[0];
        const treeProof = tree.getProof(leaf);
        console.log("Proof length:", treeProof.length);
        console.log("Proof:", treeProof);
        console.log("Proof (hex):", treeProof.map(p => p.data.toString("hex")));

        // Verify
        const verified = tree.verify(treeProof, leaf, tree.getRoot());
        console.log("Verified:", verified);

        return;
    }
    const total = allocations.reduce((acc, a) => acc.add(a.amount), new anchor.BN(0));

    const [configPda] = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("config")],
        program.programId
    );
    const [epochPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("epoch"), new anchor.BN(epochIndex).toArrayLike(Buffer, "le", 8)],
        program.programId
    );

    const tx = await program.methods
        .createRewardsEpoch(new anchor.BN(epochIndex), Array.from(root), total)
        .accountsStrict({
            config: configPda,
            admin: provider.wallet.publicKey,
            epoch: epochPda,
            systemProgram: anchor.web3.SystemProgram.programId,
        })
        .rpc();

    console.log("Transaction:", tx);
};

main().catch(console.error);
