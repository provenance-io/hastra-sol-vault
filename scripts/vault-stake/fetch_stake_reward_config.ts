import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { VaultStake } from "../../target/types/vault_stake";

const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);

const program = anchor.workspace.VaultStake as Program<VaultStake>;

// Label width matches the existing show_accounts_and_pdas output (~42 chars)
const PAD = 42;
const line = (label: string, value: string) =>
  console.log(`${(label + ":").padEnd(PAD)}${value}`);

function formatUnixTs(ts: number): string {
  if (ts === 0) return "0 (never set)";
  return `${ts} (${new Date(ts * 1000).toISOString()})`;
}

async function main() {
  const [stakeConfigPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("stake_config")],
    program.programId
  );

  const [stakeRewardConfigPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("stake_reward_config"), stakeConfigPda.toBuffer()],
    program.programId
  );

  line("Program ID (vault-stake)", program.programId.toBase58());
  line("StakeConfig PDA", stakeConfigPda.toBase58());
  line("StakeRewardConfig PDA", stakeRewardConfigPda.toBase58());

  try {
    const cfg = await program.account.stakeRewardConfig.fetch(stakeRewardConfigPda);

    line("max_reward_bps", cfg.maxRewardBps.toString());
    line("max_period_rewards", cfg.maxPeriodRewards.toString());
    line("reward_period_seconds", cfg.rewardPeriodSeconds.toString());

    const last = cfg.lastRewardDistributedAt.toNumber();
    line("last_reward_distributed_at", formatUnixTs(last));

    const nextAllowedAt = last === 0
      ? 0
      : last + cfg.rewardPeriodSeconds.toNumber();
    line("next_allowed_at", nextAllowedAt === 0 ? "0 (first publish allowed)" : formatUnixTs(nextAllowedAt));

    line("max_total_rewards", cfg.maxTotalRewards.toString());
    line("total_rewards_distributed", cfg.totalRewardsDistributed.toString());
    line("bump", String(cfg.bump));
  } catch {
    line("Status", "Not initialized");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

