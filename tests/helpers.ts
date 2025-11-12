import { PublicKey, Connection } from "@solana/web3.js";
import { getAccount } from "@solana/spl-token";

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
