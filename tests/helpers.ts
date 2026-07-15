import BN from "bn.js";
import { PublicKey, Connection } from "@solana/web3.js";
import { getAccount } from "@solana/spl-token";

/** Default `StakeRewardConfig` numeric fields (matches on-chain `state::StakeRewardConfig`). */
export const STAKE_REWARD_CONFIG_DEFAULTS = {
    maxPeriodRewards: new BN("1000000000000"),
    rewardPeriodSeconds: new BN(3540),
    maxTotalRewards: new BN("10000000000000"),
};

export async function getTokenBalance(
    connection: Connection,
    tokenAccount: PublicKey
): Promise<bigint> {
    const account = await getAccount(connection, tokenAccount);
    return account.amount;
}

export function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * After shortening `reward_period_seconds` for tests, wait long enough that Solana's
 * `Clock::unix_timestamp` (whole seconds) advances past `last_reward_distributed_at + period`.
 * Otherwise back-to-back `publish_rewards` can see the same unix second and hit
 * `RewardCooldownNotElapsed` even after a 1s nominal cooldown.
 */
export const REWARD_COOLDOWN_TEST_SLEEP_MS = 2100;
