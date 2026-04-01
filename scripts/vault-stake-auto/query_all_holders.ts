import * as anchor from "@coral-xyz/anchor";
import {Program} from "@coral-xyz/anchor";
import {VaultStakeAuto} from "../../target/types/vault_stake_auto";
import yargs from "yargs";
import {
    PublicKey,
} from "@solana/web3.js";
import {Account, unpackAccount} from "@solana/spl-token";

const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);

const program = anchor.workspace.VaultStakeAuto as Program<VaultStakeAuto>;

const args = yargs(process.argv.slice(2))
    .option("mint", {
        type: "string",
        description: "Mint address",
        required: true,
    })
    .parseSync();

/** 10^decimals as bigint without Number exponentiation (avoids overflow for large decimals). */
function pow10BigInt(decimals: number): bigint {
    let result = BigInt(1);
    const ten = BigInt(10);
    for (let i = 0; i < decimals; i += 1) {
        result = result * ten;
    }
    return result;
}

/** Human-readable token amount using only bigint math; safe for full u64 raw amounts. */
function formatUiAmount(raw: bigint, decimals: number): string {
    if (decimals === 0) {
        return raw.toString();
    }
    const divisor = pow10BigInt(decimals);
    const whole = raw / divisor;
    const frac = raw % divisor;
    return `${whole}.${frac.toString().padStart(decimals, "0")}`;
}

const main = async () => {

    const mint = new anchor.web3.PublicKey(args.mint);

    const accounts = await provider.connection.getProgramAccounts(
        new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
        {
            filters: [
                {
                    memcmp: {
                        offset: 0,
                        bytes: mint.toBase58(),
                    },
                },
                {
                    dataSize: 165, // SPL Token Account size (not Token22)
                },
            ],
        }
    );


    // 2. Fetch mint info to get decimals
    const mintInfo = await provider.connection.getParsedAccountInfo(mint, "confirmed");

    const decimals =
        // @ts-ignore
        mintInfo.value?.data?.parsed?.info?.decimals ??
        // fallback if account is not parsed
        0;

    const results: Array<{
        tokenAccount: string;
        owner: string;
        rawAmount: bigint;
        uiAmount: string;
    }> = [];

    for (const { pubkey, account } of accounts) {
        // 3. Decode each token account
        const tokenAccount: Account = unpackAccount(
            pubkey,
            account,
            new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")
        );

        const raw = tokenAccount.amount; // bigint

        results.push({
            tokenAccount: pubkey.toBase58(),
            owner: tokenAccount.owner.toBase58(),
            rawAmount: raw,
            uiAmount: formatUiAmount(raw, decimals),
        });
    }

    console.table(results);
};

main().catch(console.error);
