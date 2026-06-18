import * as anchor from "@coral-xyz/anchor";
import {Program} from "@coral-xyz/anchor";
import {VaultMint} from "../../target/types/vault_mint";
import {PublicKey} from "@solana/web3.js";
import yargs from "yargs";
import {getAssociatedTokenAddressSync} from "@solana/spl-token";
import {
    allocationsToMerkleTree,
    makeLeaf, MINT_IDL
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
        description: "Token that will be transferred (e.g. wYLDS) upon validation of the claim proof",
        required: true,
    })
    .option("amount", {
        type: "number",
        description: "Amount to claim from this epoch index",
        required: false,
    })
    .parseSync();

const program: Program<VaultMint> = new anchor.Program(MINT_IDL as anchor.Idl, provider) as Program<VaultMint>;

const main = async () => {
    const epochIndex = args.epoch;
    const { tree } = allocationsToMerkleTree(args.reward_allocations, epochIndex);

    const leaf = makeLeaf(provider.wallet.publicKey, args.amount ?? 0, epochIndex);

    console.log("Leaf:", leaf.toString("hex"));

    const treeProof = tree.getProof(leaf);
    console.log("Proof length:", treeProof.length);
    console.log("Proof (hex):", treeProof.map(p => p.data.toString("hex")));

    const proof = treeProof.map(p => ({
        sibling: Array.from(p.data),
        isLeft: p.position === "left",
    }));

    console.log("Root:", tree.getRoot().toString("hex"));
    const verified = tree.verify(treeProof, leaf, tree.getRoot());
    console.log("Verified:", verified);

    if (!verified) {
        console.warn("\n!!Proof is not valid!!\n");
    }

    const [configPda] = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("config")],
        program.programId
    );

    const indexLe = new anchor.BN(epochIndex).toArrayLike(Buffer, "le", 8);

    // V2 epoch PDA uses "epoch_v2" seed; "epoch" is the legacy V1 namespace.
    const [epochPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("epoch_v2"), indexLe],
        program.programId
    );
    const [epochCapPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("epoch_cap"), indexLe],
        program.programId
    );
    const [epochRewardsPoolPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("epoch_rewards_pool"), indexLe],
        program.programId
    );
    const [epochRewardsPoolAuthorityPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("epoch_rewards_pool_authority"), indexLe],
        program.programId
    );
    const [claimPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("claim"), epochPda.toBuffer(), provider.wallet.publicKey.toBuffer()],
        program.programId
    );

    const mint = new anchor.web3.PublicKey(args.mint);
    const tokenAccount = getAssociatedTokenAddressSync(
        mint,
        provider.wallet.publicKey,
    );

    const tx = await program.methods
        .claimRewardsV2(new anchor.BN(args.amount), proof)
        .accountsStrict({
            config: configPda,
            user: provider.wallet.publicKey,
            epoch: epochPda,
            epochCap: epochCapPda,
            claimRecord: claimPda,
            epochRewardsPool: epochRewardsPoolPda,
            epochRewardsPoolAuthority: epochRewardsPoolAuthorityPda,
            userMintTokenAccount: tokenAccount,
            tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
            systemProgram: anchor.web3.SystemProgram.programId,
        })
        .rpc();

    console.log("Transaction:", tx);
};

main().catch(console.error);
