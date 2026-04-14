import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { VaultMint } from "../../target/types/vault_mint";
import yargs from "yargs";
import { PublicKey } from "@solana/web3.js";

// Registers an additional external program as authorized to call vault-mint's
// external_program_mint instruction via CPI. Must be called once per new staking
// program (e.g. vault-stake-auto) after the updated vault-mint is deployed.
// Only the program upgrade authority can call this instruction.
//
// If the upgrade authority is a Squads vault PDA, use:
//   - register_allowed_external_mint_program_proposal_squads.ts (Squads v4 / @squads-protocol/multisig)
//   - register_allowed_external_mint_program_proposal_squads_v3.ts (Squads v3 / SMPLecH...)

const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);

const program = anchor.workspace.VaultMint as Program<VaultMint>;

const args = yargs(process.argv.slice(2))
    .option("external_program", {
        type: "string",
        description: "Program ID of the external staking program to authorize (e.g. vault-stake-auto)",
        required: true,
    })
    .parseSync();

const main = async () => {
    const signer = provider.wallet.publicKey;

    const externalProgram = new PublicKey(args.external_program);

    // Derive the vault-mint config PDA
    const [configPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("config")],
        program.programId
    );

    // Derive the AllowedExternalMintPrograms PDA (init_if_needed on first call)
    const [allowedExternalMintProgramsPda] = PublicKey.findProgramAddressSync(
        [
            Buffer.from("allowed_external_mint_programs"),
            configPda.toBuffer()
        ],
        program.programId
    );
    const [externalMintProgramsLimitConfigPda] = PublicKey.findProgramAddressSync(
        [
            Buffer.from("external_mint_programs_limit"),
            configPda.toBuffer()
        ],
        program.programId
    );

    // Derive the program data PDA (for upgrade-authority validation)
    const BPF_LOADER_UPGRADEABLE_ID = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
    const [programDataPda] = PublicKey.findProgramAddressSync(
        [program.programId.toBuffer()],
        BPF_LOADER_UPGRADEABLE_ID
    );

    console.log("Vault Mint Program ID:                    ", program.programId.toBase58());
    console.log("Config PDA:                               ", configPda.toBase58());
    console.log("AllowedExternalMintPrograms PDA:           ", allowedExternalMintProgramsPda.toBase58());
    console.log("ExternalMintProgramsLimitConfig PDA:      ", externalMintProgramsLimitConfigPda.toBase58());
    console.log("External Program to Register:              ", externalProgram.toBase58());
    console.log("Signer (upgrade authority):                ", signer.toBase58());
    console.log("Program Data PDA:                          ", programDataPda.toBase58());

    const tx = await (program.methods as any)
        .registerAllowedExternalMintProgram()
        .accountsStrict({
            config: configPda,
            allowedExternalMintPrograms: allowedExternalMintProgramsPda,
            externalMintProgramsLimitConfig: externalMintProgramsLimitConfigPda,
            externalProgram: externalProgram,
            signer: signer,
            programData: programDataPda,
            systemProgram: anchor.web3.SystemProgram.programId,
        })
        .rpc();

    console.log("Transaction:", tx);
    console.log(`Successfully registered ${externalProgram.toBase58()} as an authorized external mint caller.`);
};

main().catch(console.error);
