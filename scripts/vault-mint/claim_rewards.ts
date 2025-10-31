import * as anchor from "@coral-xyz/anchor";
import {Program} from "@coral-xyz/anchor";
import {VaultMint} from "../../target/types/vault_mint";
import {PublicKey} from "@solana/web3.js";
import yargs from "yargs";
import {getAssociatedTokenAddressSync} from "@solana/spl-token";
import {
    allocationsToMerkleTree,
    idl,
    makeLeaf
} from "../cryptolib";

const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);

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
    .option("mint", {
        type: "string",
        description: "Token that will be minted (e.g. wYLDS) upon validation of the claim proof",
        required: true,
    })
    .option("amount", {
        type: "number",
        description: "Amount to claim from this epoch index",
        required: false,
    })
    .parseSync();

const program: Program<VaultMint> = new anchor.Program(idl as anchor.Idl, provider) as Program<VaultMint>;

const main = async () => {
    const epochIndex = args.epoch;
    const { tree } = allocationsToMerkleTree(args.reward_allocations, epochIndex);

    const leaf = makeLeaf(provider.wallet.publicKey, args.amount ?? 0, epochIndex);

    console.log("Leaf:", leaf.toString("hex"));

    const treeProof = tree.getProof(leaf);
    console.log("Proof length:", treeProof.length);
    console.log("Proof:", treeProof);
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
        console.warn("\n!!Proof is not valid!!\n");
    }

    const [configPda] = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("config")],
        program.programId
    );
    const [epochPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("epoch"), new anchor.BN(epochIndex).toArrayLike(Buffer, "le", 8)],
        program.programId
    );
    // derive claim record PDA
    const [claimPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("claim"), epochPda.toBuffer(), provider.wallet.publicKey.toBuffer()],
        program.programId
    );

    const [mintAuthorityPda] = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("mint_authority")],
        program.programId
    );

    const mint = new anchor.web3.PublicKey(args.mint);
    // Calculate the Associated Token Account address
    const tokenAccount = getAssociatedTokenAddressSync(
        mint,
        provider.wallet.publicKey,
    );

    const tx = await program.methods
        .claimRewards(new anchor.BN(args.amount), proof)
        .accountsStrict({
            config: configPda,
            user: provider.wallet.publicKey,
            epoch: epochPda,
            claimRecord: claimPda,
            mintAuthority: mintAuthorityPda,
            mint: mint,
            userMintTokenAccount: tokenAccount,
            systemProgram: anchor.web3.SystemProgram.programId,
            tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID
        })
        .rpc();

    console.log("Transaction:", tx);
};

main().catch(console.error);
