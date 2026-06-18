import BN from "bn.js";
import { PublicKey, Connection } from "@solana/web3.js";
import { getAccount } from "@solana/spl-token";

// ─── V2 rewards helpers ───────────────────────────────────────────────────────

/** Derives all V2 PDAs for a given epoch index. */
export function deriveRewardsEpochV2Accounts(programId: PublicKey, index: number) {
    const indexLe = new BN(index).toArrayLike(Buffer, "le", 8);
    const [epoch] = PublicKey.findProgramAddressSync(
        [Buffer.from("epoch_v2"), indexLe],
        programId
    );
    const [epochCap] = PublicKey.findProgramAddressSync(
        [Buffer.from("epoch_cap"), indexLe],
        programId
    );
    const [epochRewardsPool] = PublicKey.findProgramAddressSync(
        [Buffer.from("epoch_rewards_pool"), indexLe],
        programId
    );
    const [epochRewardsPoolAuthority] = PublicKey.findProgramAddressSync(
        [Buffer.from("epoch_rewards_pool_authority"), indexLe],
        programId
    );
    return { epoch, epochCap, epochRewardsPool, epochRewardsPoolAuthority };
}

/**
 * Extra accounts for `createRewardsEpochV2`.
 * config / admin / epoch / systemProgram are passed separately by the caller.
 */
export function createRewardsEpochV2Accounts(
    programId: PublicKey,
    index: number,
    mint: PublicKey,
    mintAuthority: PublicKey
) {
    const { epoch: _epoch, ...v2 } = deriveRewardsEpochV2Accounts(programId, index);
    return {
        ...v2,
        mint,
        mintAuthority,
        tokenProgram: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
    };
}

/**
 * Extra accounts for `claimRewardsV2`.
 * config / user / epoch / claimRecord / userMintTokenAccount / tokenProgram / systemProgram
 * are passed separately by the caller.
 */
export function claimRewardsV2Accounts(programId: PublicKey, index: number) {
    const { epoch: _epoch, ...v2 } = deriveRewardsEpochV2Accounts(programId, index);
    return v2;
}

// ─────────────────────────────────────────────────────────────────────────────

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
