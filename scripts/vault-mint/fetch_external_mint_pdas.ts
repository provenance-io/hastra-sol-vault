/**
 * Prints vault-mint `allowed_external_mint_programs` PDA (and decoded list when allocated)
 * and the `external_mint_authority` PDA address for each known staking program.
 *
 * `external_mint_authority` is NOT a vault-mint PDA: it uses seeds [b"external_mint_authority"]
 * under each *calling* program id (vault-stake / vault-stake-auto). This script derives it
 * for Config.allowedExternalMintProgram plus any pubkeys in AllowedExternalMintPrograms.
 *
 * Optional --calling_program adds extra program ids (repeat flag or use once per id).
 *
 * Usage:
 *   ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
 *   yarn ts-node scripts/vault-mint/fetch_external_mint_pdas.ts
 *   yarn ts-node scripts/vault-mint/fetch_external_mint_pdas.ts --calling_program <EXTRA_PROGRAM_ID>
 */

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { VaultMint } from "../../target/types/vault_mint";
import yargs from "yargs";

const SYSTEM_PROGRAM_ID = new PublicKey("11111111111111111111111111111111");

const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);

const program = anchor.workspace.VaultMint as Program<VaultMint>;

const args = yargs(process.argv.slice(2))
    .option("calling_program", {
        type: "string",
        array: true,
        default: [] as string[],
        description:
            "Additional staking program id(s) to derive external_mint_authority for (repeatable)",
    })
    .parseSync();

function externalMintAuthorityPda(callingProgram: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
        [Buffer.from("external_mint_authority")],
        callingProgram
    );
}

async function main() {
    const [configPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("config")],
        program.programId
    );

    const [allowedPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("allowed_external_mint_programs"), configPda.toBuffer()],
        program.programId
    );

    const config = await program.account.config.fetch(configPda);

    console.log("=== vault-mint external program mint setup ===\n");
    console.log("Vault mint program:                    ", program.programId.toBase58());
    console.log("Config PDA:                            ", configPda.toBase58());
    console.log("Legacy allowed_external_mint_program: ", config.allowedExternalMintProgram.toBase58());
    console.log();
    console.log("AllowedExternalMintPrograms PDA:      ", allowedPda.toBase58());

    const allowedInfo = await provider.connection.getAccountInfo(allowedPda);
    let decodedAllowed: { programs: PublicKey[]; bump: number } | null = null;

    if (!allowedInfo || allowedInfo.data.length < 8) {
        console.log("  (account missing or empty — extended list not initialized yet)");
    } else {
        try {
            decodedAllowed = await program.account.allowedExternalMintPrograms.fetch(allowedPda);
            console.log("  bump:                                ", decodedAllowed.bump);
            console.log("  programs (extended allow list):");
            if (decodedAllowed.programs.length === 0) {
                console.log("    (none)");
            } else {
                for (const p of decodedAllowed.programs) {
                    console.log("   ", p.toBase58());
                }
            }
        } catch (e) {
            console.log("  (could not deserialize; len=", allowedInfo.data.length, ")", e);
        }
    }

    const callingPrograms = new Map<string, PublicKey>();

    const legacy = config.allowedExternalMintProgram;
    if (!legacy.equals(SYSTEM_PROGRAM_ID)) {
        callingPrograms.set(legacy.toBase58(), legacy);
    }

    if (decodedAllowed) {
        for (const p of decodedAllowed.programs) {
            callingPrograms.set(p.toBase58(), p);
        }
    }

    for (const extra of args.calling_program ?? []) {
        const pk = new PublicKey(extra);
        callingPrograms.set(pk.toBase58(), pk);
    }

    console.log();
    console.log("external_mint_authority PDAs (per calling program):");
    if (callingPrograms.size === 0) {
        console.log("  (no staking program ids — add --calling_program or initialize allow list)");
    } else {
        for (const cp of callingPrograms.values()) {
            const [emaPda, bump] = externalMintAuthorityPda(cp);
            const info = await provider.connection.getAccountInfo(emaPda);
            console.log();
            console.log("  calling_program:                     ", cp.toBase58());
            console.log("  external_mint_authority PDA:         ", emaPda.toBase58());
            console.log("  bump:                                ", bump);
            console.log(
                "  on-chain:                            ",
                info
                    ? `lamports=${info.lamports}, owner=${info.owner.toBase58()}, dataLen=${info.data.length}`
                    : "(no account — signer PDA may never have been allocated)"
            );
        }
    }
}

main().catch(console.error);
