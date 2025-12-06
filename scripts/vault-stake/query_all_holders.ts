import * as anchor from "@coral-xyz/anchor";
import {Program} from "@coral-xyz/anchor";
import {VaultStake} from "../../target/types/vault_stake";
import yargs from "yargs";
import {
    PublicKey,
} from "@solana/web3.js";
import {createBigInt} from "@metaplex-foundation/umi";
import {Account, unpackAccount} from "@solana/spl-token";

const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);

const program = anchor.workspace.VaultStake as Program<VaultStake>;

const args = yargs(process.argv.slice(2))
    .option("mint", {
        type: "string",
        description: "Mint address",
        required: true,
    })
    .parseSync();

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

    const divisor = BigInt(10 ** decimals);

    const results: Array<{
        tokenAccount: string;
        owner: string;
        rawAmount: bigint;
        uiAmount: number;
    }> = [];

    for (const { pubkey, account } of accounts) {
        // 3. Decode each token account
        const tokenAccount: Account = unpackAccount(
            pubkey,
            account,
            new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")
        );

        const raw = tokenAccount.amount; // bigint

        const ui = Number(raw) / Number(divisor);

        results.push({
            tokenAccount: pubkey.toBase58(),
            owner: tokenAccount.owner.toBase58(),
            rawAmount: raw,
            uiAmount: ui,
        });
    }

    console.table(results);
};

main().catch(console.error);
