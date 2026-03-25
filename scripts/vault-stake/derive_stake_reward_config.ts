import * as anchor from "@coral-xyz/anchor";

const VAULT_STAKE_PROGRAM_ID = new anchor.web3.PublicKey(
    "97V7JsExNC6yFWu5KjK1FLfVkNVvtMpAFL5QkLWKEGxY"
);

const [stakeConfigPda] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("stake_config")],
    VAULT_STAKE_PROGRAM_ID
);

const [stakeRewardConfigPda] = anchor.web3.PublicKey.findProgramAddressSync(
    [Buffer.from("stake_reward_config"), stakeConfigPda.toBuffer()],
    VAULT_STAKE_PROGRAM_ID
);

console.log("Program ID:            ", VAULT_STAKE_PROGRAM_ID.toBase58());
console.log("StakeConfig PDA:       ", stakeConfigPda.toBase58());
console.log("StakeRewardConfig PDA: ", stakeRewardConfigPda.toBase58());
