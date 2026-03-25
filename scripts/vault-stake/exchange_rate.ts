import * as anchor from "@coral-xyz/anchor";
import {Program} from "@coral-xyz/anchor";
import {VaultStake} from "../../target/types/vault_stake";
import yargs from "yargs";
import {
    PublicKey,
} from "@solana/web3.js";

const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);

const program = anchor.workspace.VaultStake as Program<VaultStake>;

const args = yargs(process.argv.slice(2))
    .option("mint", {
        type: "string",
        description: "Staking token mint address",
        required: true,
    })
    .option("vault_token_account", {
        type: "string",
        description: "Vault token account address",
        required: true,
    })
    .parseSync();

const main = async () => {
    const [stakeConfigPda, bump] = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("stake_config")],
        program.programId
    );

    const [stakePriceConfigPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("stake_price_config"), stakeConfigPda.toBuffer()],
        program.programId
    );

    const [vaultAuthorityPda] = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("vault_authority")],
        program.programId
    )

    const mint = new anchor.web3.PublicKey(args.mint);
    const vaultTokenAccount = new anchor.web3.PublicKey(args.vault_token_account);

    console.log("Program ID:", program.programId.toBase58());
    console.log("Stake Config PDA:", stakeConfigPda.toBase58());
    console.log("Mint:", mint.toBase58());
    console.log("Vault Token Account:", vaultTokenAccount.toBase58());
    console.log("Vault Authority PDA:", vaultAuthorityPda.toBase58());

    // Call exchange_rate
    const sig = await program.methods
        .exchangeRate()
        .accountsStrict({
            stakeConfig: stakeConfigPda,
            stakePriceConfig: stakePriceConfigPda,
            vaultAuthority: vaultAuthorityPda,
            mint: mint,
            vaultTokenAccount: vaultTokenAccount,
        })
        .rpc()

    const s = await program.provider.connection.getParsedTransaction(sig,
        {
            commitment: "confirmed",
            maxSupportedTransactionVersion: 0
        }
    );
    // get the return data from the last instruction
    if (!!s?.meta["returnData"]) {
        const returnData = s!.meta!["returnData"].data;
        const buffer = Buffer.from(returnData[0], returnData[1]);
        // exchange_rate() returns a u64 scaled by 1e9 (see processor.rs SCALE constant).
        // e.g. 1_000_000_000 → 1.000000000 wYLDS per PRIME
        const SCALE = BigInt(1_000_000_000);
        const raw = BigInt(new anchor.BN(buffer, "le").toString());
        const whole = raw / SCALE;
        const frac = (raw % SCALE).toString().padStart(9, "0");
        console.log(`Exchange Rate: ${whole}.${frac} wYLDS per PRIME  (raw: ${raw})`);
    }
};

main().catch(console.error);
