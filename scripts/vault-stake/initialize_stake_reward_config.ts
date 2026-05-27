/**
 * initialize_stake_reward_config.ts
 *
 * Calls `initialize_stake_reward_config` on vault-stake. Creates the StakeRewardConfig PDA
 * with protocol defaults (see StakeRewardConfig in state.rs). The connected wallet must be
 * the program upgrade authority.
 *
 * Use this when the PDA does not exist yet (e.g. new deployment). Fails if the account
 * already exists — use set_reward_config_proposal_squads.ts or the update_* reward instructions instead.
 *
 * Requires a program build that includes `initialize_stake_reward_config` (run `anchor build`
 * so target/idl and types are current).
 *
 * Usage:
 *   ANCHOR_PROVIDER_URL=https://api.mainnet-beta.solana.com \
 *   ANCHOR_WALLET=~/.config/solana/id.json \
 *   yarn ts-node scripts/vault-stake/initialize_stake_reward_config.ts
 *
 * Optional: --program_id <PUBKEY>
 */

import * as anchor from "@coral-xyz/anchor";
import { AnchorProvider, Program } from "@coral-xyz/anchor";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import yargs from "yargs";
import { VaultStake } from "../../target/types/vault_stake";

const args = yargs(process.argv.slice(2))
    .option("program_id", {
        type: "string",
        description: "Optional vault-stake program id override",
    })
    .parseSync();

async function main() {
    const provider = AnchorProvider.env();
    anchor.setProvider(provider);
    const workspaceProgram = anchor.workspace.VaultStake as Program<VaultStake>;
    const resolvedIdl = JSON.parse(JSON.stringify(workspaceProgram.idl));
    if (args.program_id) {
        new PublicKey(args.program_id);
        resolvedIdl.address = args.program_id;
        if (resolvedIdl.metadata) {
            resolvedIdl.metadata.address = args.program_id;
        }
    }
    const program = new anchor.Program(resolvedIdl as anchor.Idl, provider) as Program<VaultStake>;

    const [stakeConfigPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("stake_config")],
        program.programId
    );
    const [stakeRewardConfigPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("stake_reward_config"), stakeConfigPda.toBuffer()],
        program.programId
    );
    const BPF_LOADER_UPGRADEABLE_ID = new PublicKey(
        "BPFLoaderUpgradeab1e11111111111111111111111"
    );
    const [programDataPda] = PublicKey.findProgramAddressSync(
        [program.programId.toBuffer()],
        BPF_LOADER_UPGRADEABLE_ID
    );

    const signer = provider.wallet.publicKey;

    console.log("=== initialize_stake_reward_config (vault-stake) ===\n");
    console.log("Program ID:            ", program.programId.toBase58());
    console.log("StakeConfig PDA:       ", stakeConfigPda.toBase58());
    console.log("StakeRewardConfig PDA: ", stakeRewardConfigPda.toBase58());
    console.log("Program Data PDA:      ", programDataPda.toBase58());
    console.log("Signer (must be upgrade authority):", signer.toBase58());
    console.log();

    const sig = await program.methods
        .initializeStakeRewardConfig()
        .accountsStrict({
            stakeConfig: stakeConfigPda,
            stakeRewardConfig: stakeRewardConfigPda,
            signer,
            programData: programDataPda,
            systemProgram: SystemProgram.programId,
        })
        .rpc({ commitment: "confirmed" });

    console.log("Signature:", sig);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
