import * as anchor from "@coral-xyz/anchor";
import {Program} from "@coral-xyz/anchor";
import {VaultMint} from "../../target/types/vault_mint";
import {PublicKey} from "@solana/web3.js";
import yargs from "yargs";
import {MINT_IDL} from "../cryptolib";

const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);

const program: Program<VaultMint> = new anchor.Program(MINT_IDL as anchor.Idl, provider) as Program<VaultMint>;

const args = yargs(process.argv.slice(2))
    .option("first_capped_epoch", {
        type: "number",
        description: "First epoch index that enforces aggregate claim caps",
        required: true,
    })
    .option("max_epoch_cap", {
        type: "string",
        description: "Global ceiling on create_rewards_epoch.total (raw token units)",
        required: true,
    })
    .parseSync();

const main = async () => {
    const [configPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("config")],
        program.programId
    );
    const [epochCapsConfigPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("epoch_caps_config")],
        program.programId
    );
    const [programData] = PublicKey.findProgramAddressSync(
        [program.programId.toBuffer()],
        new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111")
    );

    const tx = await program.methods
        .initializeEpochCaps(
            new anchor.BN(args.first_capped_epoch),
            new anchor.BN(args.max_epoch_cap),
        )
        .accountsStrict({
            config: configPda,
            epochCapsConfig: epochCapsConfigPda,
            signer: provider.wallet.publicKey,
            programData,
            systemProgram: anchor.web3.SystemProgram.programId,
        })
        .rpc();

    console.log("initialize_epoch_caps tx:", tx);
    console.log("epoch_caps_config:", epochCapsConfigPda.toBase58());
};

main().catch(console.error);
