import * as anchor from "@coral-xyz/anchor";
import {createHash} from "crypto";
import {PublicKey} from "@solana/web3.js";
import {MerkleTree} from "merkletreejs";


export const MINT_IDL = require("../target/idl/vault_mint.json");
export const STAKE_IDL = require("../target/idl/vault_stake.json");
export const ZERO32 = Buffer.alloc(0);
export const sha256 = (x: Buffer) => createHash("sha256").update(x).digest();

/** Leaf domain version. V2 prefixes with ASCII "v2" to separate from legacy V1 trees. */
export type LeafVersion = "v1" | "v2";

const LEAF_DOMAIN_V2 = Buffer.from("v2");

/**
 * Builds a rewards Merkle leaf.
 * V1 (legacy): sha256(user || amount_le || epoch_index_le)
 * V2: sha256("v2" || user || amount_le || epoch_index_le)
 */
export const makeLeaf = (
    user: PublicKey,
    amount: anchor.BN | number,
    epoch: number,
    version: LeafVersion = "v2",
): Buffer => {
    const amountBytes = (anchor.BN.isBN(amount) ? amount : new anchor.BN(amount)).toArrayLike(Buffer, "le", 8);
    const epochBytes = new anchor.BN(epoch).toArrayLike(Buffer, "le", 8);
    const parts =
        version === "v2"
            ? [LEAF_DOMAIN_V2, user.toBuffer(), amountBytes, epochBytes]
            : [user.toBuffer(), amountBytes, epochBytes];
    return sha256(Buffer.concat(parts));
}

export const nextPowerOf2Math = (n: number): number => {
    if (n <= 0) {
        return 1; // Or handle as an error
    }
    const power = Math.ceil(Math.log2(n));
    return Math.pow(2, power);
}

export const padToPowerOfTwo = (leaves: Buffer<ArrayBufferLike>[])=> {
    //Sort the leaves to ensure consistent tree structure and padding at the end
    leaves.sort(Buffer.compare);
    const n = nextPowerOf2Math(leaves.length);
    const padded = leaves.slice();
    while (padded.length < n) {
        padded.push(ZERO32);
    }
    return padded;
}


export const allocationsToMerkleTree = (
    allocationString: string,
    epochIndex: number,
    version: LeafVersion = "v2",
) => {
    const allocations: {user: PublicKey, amount: anchor.BN}[] = (JSON.parse(allocationString).allocations as {account: string, amount: number}[]).map((a: {account: string, amount: number}) => {
        return {user: new PublicKey(a.account), amount: new anchor.BN(a.amount)};
    });

    console.log("Epoch:", epochIndex.toString());
    console.log("Leaf version:", version);
    console.log("Allocations:", allocations.map(a => ({user: a.user.toBase58(), amount: a.amount.toString()})));

    const leaves = padToPowerOfTwo(allocations.map(a => makeLeaf(a.user, a.amount, epochIndex, version)));

    console.log(`\nLeaves (${leaves.length}):`);
    leaves.forEach((leaf, i) => {
        console.log(`${i}: ${leaf.toString("hex")}`);
    });

    const tree = new MerkleTree(leaves, sha256, {
        sortPairs: false,
    });

    console.log(`\nTree:`);
    console.log(`Depth: ${tree.getDepth()}`);
    console.log(`Root: ${tree.getRoot().toString("hex")}`);
    console.log(tree.toString());

    return {allocations, leaves, tree};
}
