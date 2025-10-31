import yargs from "yargs";
import {allocationsToMerkleTree, makeLeaf, sha256} from "../cryptolib";
import {PublicKey} from "@solana/web3.js";
import {BN} from "@coral-xyz/anchor";

const args = yargs(process.argv.slice(2))
    .option("epoch", {
        type: "number",
        description: "Epoch index",
        required: true,
    })
    .option("reward_allocations", {
        type: "string",
        description: "Allocations object: {allocations: [{\"account\": \"3m7...sKf\", \"amount\": 1000}, ...]}",
        required: true,
    })
    .option("hastra_proof", {
        type: "string",
        description: "json string of the Hastra proof to validate:\n {\n" +
            "  \"proof\": {\n" +
            "    \"Hashes\": [\n" +
            "      \"x+YyIwN5ob86+VTSSlY/TaWFi8Aw776N2dR1Zi7avSY=\",\n" +
            "      \"uNgLidu1Chx8X/llAgl6b0cfxcfTeMouLJ1keG09B/g=\"\n" +
            "    ],\n" +
            "    \"Index\": 2\n" +
            "  },\n" +
            "  \"amount\": \"4484140\",\n" +
            "  \"epoch\": 81\n" +
            "}",
        required: true,
    })
    .option("account", {
        type: "string",
        description: "Account to validate the proof for (defaults to the provider wallet)",
        required: true
    })
    .option("amount", {
        type: "string",
        description: "Account to validate the proof for (defaults to the provider wallet)",
        required: true
    })

    .parseSync();

const main = async () => {
    const epochIndex = args.epoch;
    const {tree} = allocationsToMerkleTree(args.reward_allocations, epochIndex);

    const leaf = makeLeaf(new PublicKey(args.account), new BN(args.amount) ?? 0, epochIndex);

    console.log("Leaf:", leaf.toString("hex"));

    const treeProof = tree.getProof(leaf);
    console.log("Proof length:", treeProof.length);
    console.log("Tree Proof:", treeProof);
    console.log("Proof (hex):", treeProof.map(p => p.data.toString("hex")));

    const proof = treeProof.map(p => ({
        sibling: Array.from(p.data),
        isLeft: p.position === "left",
    }));

    console.log("Proof:", proof);
    console.log("Root:", tree.getRoot().toString("hex"));
    // Verify
    const verified = tree.verify(treeProof, leaf, tree.getRoot());
    console.log("Verified:", verified);

    if (!verified) {
        console.warn("\n!!Proof of rewards_allocations is not valid!!\n");
        return;
    }

    const hastraProofObj = JSON.parse(args.hastra_proof);
    const hpo: {sibling:number[]; isLeft: boolean}[] = hastraProofObj.hastraProof.map((h) => ({
        position: h.position,
        data: Buffer.from(h.data, 'hex'),
    }))
    console.log("Hastra Proof:", hpo);

    const hastraVerified = tree.verify(hpo, leaf, tree.getRoot());
    console.log("Hastra Proof Verified:", hastraVerified);
};

main().catch(console.error);
