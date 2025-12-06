import * as anchor from "@coral-xyz/anchor";
import {Program} from "@coral-xyz/anchor";
import {VaultStake} from "../../target/types/vault_stake";
import yargs from "yargs";
import {
    PublicKey,
} from "@solana/web3.js";
import {createBigInt} from "@metaplex-foundation/umi";

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

    // Call initialize
    const sig = await program.methods
        .exchangeRate()
        .accountsStrict({
            stakeConfig: stakeConfigPda,
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
        const exchangeRate = createBigInt(new anchor.BN(buffer, "le").toNumber());
        console.log("Exchange Rate:", exchangeRate.toString());
    }
};

main().catch(console.error);
