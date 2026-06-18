import * as anchor from "@coral-xyz/anchor";
import {Program} from "@coral-xyz/anchor";
import {VaultMint} from "../../target/types/vault_mint";
import {PublicKey} from "@solana/web3.js";
import yargs from "yargs";
import {allocationsToMerkleTree, MINT_IDL} from "../cryptolib";
import * as fs from "fs";

const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);

const program: Program<VaultMint> = new anchor.Program(MINT_IDL as anchor.Idl, provider) as Program<VaultMint>;

const args = yargs(process.argv.slice(2))
    .option("epoch", {
        type: "number",
        description: "Epoch index",
        required: true,
    })
    .option("number_of_allocations", {
        type: "number",
        description: "Number of allocations to generate (for testing)",
        required: false,
        default: 10,
    })
    .option("include_wallets", {
        type: "string",
        description: "Comma-separated list of wallet addresses to include in the allocations (for testing)",
        required: false,
        default: "",
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
    const numberOfAllocations = args.number_of_allocations;
    const includeWallets = args.include_wallets.split(",").map(s => s.trim()).filter(s => s.length > 0);

    // Generate test allocations
    const testAllocations = [];
    for (let i = 0; i < numberOfAllocations; i++) {
        if(i > numberOfAllocations - includeWallets.length - 1) {
            testAllocations.push({
                account: includeWallets[i - (numberOfAllocations - includeWallets.length)],
                amount: 1000 + i * 100,
            });
        } else {
            //generate and add random wallet
            const wallet = anchor.web3.Keypair.generate().publicKey.toBase58();
            testAllocations.push({
                account: wallet,
                amount: 1000 + i * 100,
            });
        }
    }

    fs.writeFileSync("test_allocations.json", JSON.stringify({ allocations: testAllocations}, null, 2));

    const { tree, leaves, allocations } = allocationsToMerkleTree(JSON.stringify({ allocations: testAllocations}), epochIndex);
    const root = tree.getRoot();

    if (args.just_print) {
        const leaf = leaves[0];
        const treeProof = tree.getProof(leaf);
        console.log("Proof length:", treeProof.length);
        console.log("Proof:", treeProof);
        console.log("Proof (hex):", treeProof.map(p => p.data.toString("hex")));

        const verified = tree.verify(treeProof, leaf, tree.getRoot());
        console.log("Verified:", verified);

        return;
    }
    const total = allocations.reduce((acc, a) => acc.add(a.amount), new anchor.BN(0));

    const [configPda] = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("config")],
        program.programId
    );

    // Fetch the wYLDS mint from config so callers don't need to supply it manually.
    const config = await program.account.config.fetch(configPda);
    const mint = config.mint;

    const [mintAuthorityPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("mint_authority")],
        program.programId
    );

    const indexLe = new anchor.BN(epochIndex).toArrayLike(Buffer, "le", 8);

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

    const tx = await program.methods
        .createRewardsEpochV2(new anchor.BN(epochIndex), Array.from(root), total)
        .accountsStrict({
            config: configPda,
            admin: provider.wallet.publicKey,
            epoch: epochPda,
            epochCap: epochCapPda,
            epochRewardsPool: epochRewardsPoolPda,
            epochRewardsPoolAuthority: epochRewardsPoolAuthorityPda,
            mint,
            mintAuthority: mintAuthorityPda,
            tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
            systemProgram: anchor.web3.SystemProgram.programId,
        })
        .rpc();

    console.log("Transaction:", tx);
};

main().catch(console.error);
