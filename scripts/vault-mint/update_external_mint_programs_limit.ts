import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { VaultMint } from "../../target/types/vault_mint";
import yargs from "yargs";
import { PublicKey } from "@solana/web3.js";

// Updates the cap used by register_allowed_external_mint_program.
// Only the vault-mint program upgrade authority can call this instruction.

const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);

const program = anchor.workspace.VaultMint as Program<VaultMint>;

const args = yargs(process.argv.slice(2))
    .option("max_programs", {
        type: "number",
        description: "Maximum number of allowed external mint programs (0-255)",
        required: true,
    })
    .parseSync();

const main = async () => {
    const signer = provider.wallet.publicKey;
    const maxPrograms = Number(args.max_programs);

    if (!Number.isInteger(maxPrograms) || maxPrograms < 0 || maxPrograms > 255) {
        throw new Error("--max_programs must be an integer in the range [0, 255]");
    }

    const [configPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("config")],
        program.programId
    );
    const [externalMintProgramsLimitConfigPda] = PublicKey.findProgramAddressSync(
        [
            Buffer.from("external_mint_programs_limit"),
            configPda.toBuffer(),
        ],
        program.programId
    );

    const BPF_LOADER_UPGRADEABLE_ID = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
    const [programDataPda] = PublicKey.findProgramAddressSync(
        [program.programId.toBuffer()],
        BPF_LOADER_UPGRADEABLE_ID
    );

    console.log("Vault Mint Program ID:                   ", program.programId.toBase58());
    console.log("Config PDA:                              ", configPda.toBase58());
    console.log("ExternalMintProgramsLimitConfig PDA:     ", externalMintProgramsLimitConfigPda.toBase58());
    console.log("Signer (upgrade authority):              ", signer.toBase58());
    console.log("Program Data PDA:                        ", programDataPda.toBase58());
    console.log("New allowed-program limit:               ", maxPrograms);

    const tx = await (program.methods as any)
        .updateExternalMintProgramsLimit(maxPrograms)
        .accountsStrict({
            config: configPda,
            externalMintProgramsLimitConfig: externalMintProgramsLimitConfigPda,
            signer,
            programData: programDataPda,
            systemProgram: anchor.web3.SystemProgram.programId,
        })
        .rpc();

    console.log("Transaction:", tx);
    console.log(`Successfully updated external mint program limit to ${maxPrograms}.`);
};

main().catch(console.error);
