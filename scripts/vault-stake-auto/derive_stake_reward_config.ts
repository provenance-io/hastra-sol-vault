import * as anchor from "@coral-xyz/anchor";

// Default: vault-stake-auto localnet ID from Anchor.toml; override for other clusters.
const VAULT_STAKE_AUTO_PROGRAM_ID = new anchor.web3.PublicKey(
    "xZS9aDDtDS35huN9FhaoCeidGaV1S1M1KWGLV9jLY59"
);

const [stakeConfigPda] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("stake_config")],
    VAULT_STAKE_AUTO_PROGRAM_ID
);

const [stakeRewardConfigPda] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("stake_reward_config"), stakeConfigPda.toBuffer()],
    VAULT_STAKE_AUTO_PROGRAM_ID
);

console.log("Program ID (vault-stake-auto): ", VAULT_STAKE_AUTO_PROGRAM_ID.toBase58());
console.log("StakeConfig PDA:               ", stakeConfigPda.toBase58());
console.log("StakeRewardConfig PDA:         ", stakeRewardConfigPda.toBase58());
