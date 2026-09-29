import * as anchor from "@coral-xyz/anchor";
import yargs from "yargs";
import { BN, Program } from "@coral-xyz/anchor";
import { VaultMint } from "../../target/types/vault_mint";
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddress } from "@solana/spl-token";

const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);

const workspaceProgram = anchor.workspace.VaultMint as Program<VaultMint>;

const args = yargs(process.argv.slice(2))
    .option("user", {
        type: "string",
        description: "The user's public key who made the redemption request.",
        required: true,
    })
    .option("mint", {
        type: "string",
        description: "The mint token that will be burned (e.g. wYLDS).",
        required: true,
    })
    .option("vault_mint", {
        type: "string",
        description: "The vault mint token (e.g. USDC) to transfer to user.",
        required: true,
    })
    .option("redeem_vault_token_account", {
        type: "string",
        description: "Token account that will hold vaulted asset (e.g. USDC) used for redemptions.",
        required: true,
    })
    // Must be supplied from the approval record, not read off-chain from the request, or the check
    // it feeds is meaningless: the point is to reject a request substituted after that approval.
    .option("expected_amount", {
        type: "string",
        description:
            "Raw token amount the administrator approved. Must equal the amount recorded on the " +
            "request or the program rejects with RedemptionAmountMismatch.",
        required: true,
    })
    .option("program_id", {
        type: "string",
        description: "Optional vault-mint program id override",
    })
    .parseSync();

const main = async () => {
    const resolvedIdl = JSON.parse(JSON.stringify(workspaceProgram.idl));
    if (args.program_id) {
        new PublicKey(args.program_id);
        resolvedIdl.address = args.program_id;
        if (resolvedIdl.metadata) {
            resolvedIdl.metadata.address = args.program_id;
        }
    }
    const program = new anchor.Program(resolvedIdl as anchor.Idl, provider) as Program<VaultMint>;

    const admin = provider.wallet.publicKey;
    const user = new PublicKey(args.user);
    const mint = new PublicKey(args.mint);
    const vaultMint = new PublicKey(args.vault_mint);
    const redeemVaultTokenAccount = new PublicKey(args.redeem_vault_token_account);
    const expectedAmount = new BN(args.expected_amount);

    // Derive PDAs
    const [configPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("config")],
        program.programId
    );

    const [redemptionRequestPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("redemption_request"), user.toBuffer()],
        program.programId
    );

    const [redeemVaultAuthorityPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("redeem_vault_authority")],
        program.programId
    );

    // Get token accounts
    const userMintTokenAccount = await getAssociatedTokenAddress(mint, user);
    const userVaultTokenAccount = await getAssociatedTokenAddress(vaultMint, user);

    console.log(`Admin:                         ${admin.toBase58()}`);
    console.log(`User:                          ${user.toBase58()}`);
    console.log(`User Mint Token Account:       ${userMintTokenAccount.toBase58()}`);
    console.log(`User Vault Token Account:      ${userVaultTokenAccount.toBase58()}`);
    console.log(`Mint:                          ${mint.toBase58()}`);
    console.log(`Vault Mint:                    ${vaultMint.toBase58()}`);
    console.log(`Config PDA:                    ${configPda.toBase58()}`);
    console.log(`Redeem Vault Token Account:    ${redeemVaultTokenAccount.toBase58()}`);
    console.log(`Redemption Request PDA:        ${redemptionRequestPda.toBase58()}`);
    console.log(`Redeem Vault Authority PDA:    ${redeemVaultAuthorityPda.toBase58()}`);
    console.log(`Token Program:                 ${anchor.utils.token.TOKEN_PROGRAM_ID.toBase58()}`);
    console.log(`Approved Amount:               ${expectedAmount.toString()}`);

    // Surfaced for the operator only; the program performs the authoritative comparison.
    const request = await program.account.redemptionRequest.fetch(redemptionRequestPda);
    console.log(`On-chain Request Amount:       ${request.amount.toString()}`);
    if (!request.amount.eq(expectedAmount)) {
        console.warn(
            "WARNING: the on-chain request does not match the approved amount. The request was " +
            "replaced after approval and the program will reject this transaction."
        );
    }

    const tx = await program.methods
        .completeRedeem(expectedAmount)
        .accountsStrict({
            admin: admin,
            user: user,
            userMintTokenAccount: userMintTokenAccount,
            userVaultTokenAccount: userVaultTokenAccount,
            redemptionRequest: redemptionRequestPda,
            redeemVaultTokenAccount: redeemVaultTokenAccount,
            redeemVaultAuthority: redeemVaultAuthorityPda,
            mint: mint,
            config: configPda,
            tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
        })
        .rpc();

    console.log("Complete redeem transaction:", tx);
};

main().catch(console.error);
