#!/usr/bin/env ts-node
/**
 * tx-inspect.ts — Inspect a Solana transaction for errors and logs
 *
 * Usage:
 *   yarn ts-node scripts/tx-inspect.ts <TX_SIGNATURE> [--cluster devnet|mainnet-beta|localnet]
 *
 * Examples:
 *   yarn ts-node scripts/tx-inspect.ts 5Gkjsqq... --cluster devnet
 *   yarn ts-node scripts/tx-inspect.ts 5Gkjsqq...                  # defaults to devnet
 */

import { Connection, clusterApiUrl } from "@solana/web3.js";

const CUSTOM_ERROR_CODES: Record<number, string> = {
    // anchor built-ins
    100:  "InstructionMissing",
    101:  "InstructionFallbackNotFound",
    102:  "InstructionDidNotDeserialize",
    103:  "InstructionDidNotSerialize",
    1000: "IdlInstructionStub",
    1001: "IdlInstructionInvalidProgram",
    2000: "ConstraintMut",
    2001: "ConstraintHasOne",
    2002: "ConstraintSigner",
    2003: "ConstraintRaw",
    2004: "ConstraintOwner",
    2005: "ConstraintMintMintAuthority",
    2006: "ConstraintMintFreezeAuthority",
    2007: "ConstraintMintDecimals",
    2008: "ConstraintSpace",
    2009: "ConstraintAccountIsNone",
    2010: "ConstraintTokenMint",
    2011: "ConstraintTokenOwner",
    2012: "ConstraintAssociatedInit",
    2013: "ConstraintAssociated",
    2014: "ConstraintSeeds",
    2015: "ConstraintExecutable",
    2016: "ConstraintState",
    2017: "ConstraintAddress",
    2018: "ConstraintZero",
    2019: "ConstraintTokenProgram",
    2020: "ConstraintMintTokenProgram",
    2021: "ConstraintGroup",
    3000: "AccountDiscriminatorAlreadySet",
    3001: "AccountDiscriminatorNotFound",
    3002: "AccountDiscriminatorMismatch",
    3003: "AccountDidNotDeserialize",
    3004: "AccountDidNotSerialize",
    3005: "AccountNotEnoughKeys",
    3006: "AccountNotMutable",
    3007: "AccountOwnedByWrongProgram",
    3008: "InvalidProgramId",
    3009: "InvalidProgramExecutable",
    3010: "AccountNotSigner",
    3011: "AccountNotSystemOwned",
    3012: "AccountNotInitialized",
    3013: "AccountNotProgramData",
    3014: "AccountNotAssociatedTokenAccount",
    3015: "AccountSysvarMismatch",
    3016: "AccountReallocExceedsLimit",
    3017: "AccountDuplicateReallocs",
    4000: "DeclaredProgramIdMismatch",
    4100: "TryingToInitPayerAsProgramAccount",
    5000: "InvalidNumericConversion",
    // vault-mint custom errors (6000+)
    6000: "InvalidVaultTokenAccount",
    6001: "InvalidRedeemerTokenAccount",
    6002: "InvalidTokenOwner",
    6003: "InvalidAuthority",
    6004: "InvalidMint",
    6005: "InvalidVaultMint",
    6006: "DepositLimitExceeded",
    6007: "ProtocolPaused",
    6008: "InvalidAmount",
    6009: "InvalidProgramData",
    6010: "InvalidMintAuthority",
    6011: "InsufficientRedeemVaultFunds",
    // vault-stake custom errors (6000+ in that program)
    6030: "InvalidRewardsAdministrator",
    6031: "InvalidFreezeAdministrator",
    6032: "TooManyAdministrators",
    6033: "ReportStale",
    6034: "PriceNotSet",
    6035: "Overflow",
    6036: "VaultAndMintCannotBeSame",
    6037: "InvalidVaultAuthority",
    6038: "InvalidVaultTokenAccount",
    6039: "InvalidVaultMint",
    6040: "InvalidMint",
    6041: "RewardExceedsMaxDelta",
    6042: "InvalidMaxRewardBps",
};

const CLUSTER_URLS: Record<string, string> = {
    devnet:        clusterApiUrl("devnet"),
    "mainnet-beta": clusterApiUrl("mainnet-beta"),
    mainnet:       clusterApiUrl("mainnet-beta"),
    localnet:      "http://127.0.0.1:8899",
    localhost:     "http://127.0.0.1:8899",
};

function resolveErrorCode(code: number): string {
    return CUSTOM_ERROR_CODES[code]
        ? `${CUSTOM_ERROR_CODES[code]} (0x${code.toString(16)})`
        : `Unknown (0x${code.toString(16)} / ${code})`;
}

function parseErr(err: any, depth = 0): string[] {
    const pad = "  ".repeat(depth);
    if (!err) return [`${pad}No error (transaction succeeded)`];
    if (typeof err === "string") return [`${pad}${err}`];
    if (err.InstructionError) {
        const [idx, detail] = err.InstructionError;
        const lines = [`${pad}InstructionError at instruction index ${idx}:`];
        if (typeof detail === "string") {
            lines.push(`${pad}  ${detail}`);
        } else if (detail?.Custom !== undefined) {
            lines.push(`${pad}  Custom error: ${resolveErrorCode(detail.Custom)}`);
        } else {
            lines.push(`${pad}  ${JSON.stringify(detail)}`);
        }
        return lines;
    }
    return [`${pad}${JSON.stringify(err)}`];
}

async function main() {
    const args = process.argv.slice(2);
    if (args.length === 0) {
        console.error("Usage: yarn ts-node scripts/tx-inspect.ts <TX_SIGNATURE> [--cluster devnet|mainnet-beta|localnet]");
        process.exit(1);
    }

    const sig = args[0];
    const clusterFlag = args.indexOf("--cluster");
    const clusterName = clusterFlag !== -1 ? args[clusterFlag + 1] : "devnet";
    const rpcUrl = CLUSTER_URLS[clusterName] ?? clusterName; // also accepts a raw URL

    const connection = new Connection(rpcUrl, "confirmed");

    console.log(`\nCluster : ${clusterName} (${rpcUrl})`);
    console.log(`Sig     : ${sig}\n`);

    const tx = await connection.getTransaction(sig, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
    });

    if (!tx) {
        console.error("Transaction not found (too old, wrong cluster, or not yet confirmed).");
        process.exit(1);
    }

    const meta = tx.meta!;

    // ── Status ──────────────────────────────────────────────────────────────
    const succeeded = meta.err === null;
    console.log(`Status  : ${succeeded ? "✅ SUCCESS" : "❌ FAILED"}`);
    if (!succeeded) {
        const errLines = parseErr(meta.err);
        console.log("Error   :");
        errLines.forEach(l => console.log(l));
    }

    // ── Logs ────────────────────────────────────────────────────────────────
    console.log("\nLogs:");
    (meta.logMessages ?? []).forEach(l => {
        // Highlight error lines
        const prefix = l.includes("failed") || l.includes("Error") ? "  ⚠️  " : "      ";
        console.log(`${prefix}${l}`);
    });

    // ── Fee & accounts ──────────────────────────────────────────────────────
    console.log(`\nFee     : ${meta.fee} lamports`);
    console.log(`CU used : ${meta.computeUnitsConsumed ?? "n/a"}`);
}

main().catch(e => { console.error(e); process.exit(1); });
