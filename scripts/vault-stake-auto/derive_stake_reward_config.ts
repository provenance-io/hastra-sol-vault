import * as anchor from "@coral-xyz/anchor";
import yargs from "yargs";

/** Default: vault-stake-auto localnet program ID (Anchor.toml). */
const DEFAULT_PROGRAM_ID = "xZS9aDDtDS35huN9FhaoCeidGaV1S1M1KWGLV9jLY59";

const args = yargs(process.argv.slice(2))
    .option("program_id", {
        type: "string",
        description: "vault-stake-auto program ID",
        default: DEFAULT_PROGRAM_ID,
    })
    .parseSync();

const main = async () => {
    const programId = new anchor.web3.PublicKey(args.program_id);

    const [stakeConfigPda] = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("stake_config")],
        programId
    );

    const [stakeRewardConfigPda] = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("stake_reward_config"), stakeConfigPda.toBuffer()],
        programId
    );

    console.log("Program ID (vault-stake-auto): ", programId.toBase58());
    console.log("StakeConfig PDA:               ", stakeConfigPda.toBase58());
    console.log("StakeRewardConfig PDA:         ", stakeRewardConfigPda.toBase58());
};

main().catch(console.error);
