/**
 * Localnet helper: initialize StakePriceConfig and optionally setPriceForTesting.
 * Supports the PRIME pool (vault-stake) or AUTO pool (vault-stake-auto).
 *
 * Signer must be the program upgrade authority (use ANCHOR_WALLET or
 * --use_local_validator_config to load upgradeAuthority from config.json).
 */

import * as anchor from "@coral-xyz/anchor";
import {AnchorProvider, BN, Program, Wallet} from "@coral-xyz/anchor";
import {Connection, PublicKey, SystemProgram} from "@solana/web3.js";
import yargs from "yargs";
import {VaultStake} from "../../target/types/vault_stake";
import {VaultStakeAuto} from "../../target/types/vault_stake_auto";
import {
    defaultLocalValidatorConfigPath,
    keypairFromConfigSecret,
    readLocalValidatorConfig,
} from "./local_validator_config";

type StakePriceProgram = Program<VaultStake> | Program<VaultStakeAuto>;

const args = yargs(process.argv.slice(2))
    .option("pool", {
        type: "string",
        choices: ["prime", "auto"],
        default: "prime",
        description:
            "prime = vault-stake (PRIME); auto = vault-stake-auto (share token)",
    })
    .option("use_local_validator_config", {
        type: "boolean",
        default: false,
        description:
            "Sign with upgradeAuthority from scripts/.local-validator/config.json (RPC from config or ANCHOR_PROVIDER_URL)",
    })
    .option("local_validator_config", {
        type: "string",
        default: defaultLocalValidatorConfigPath(),
        description: "Path to local validator config.json",
    })
    .option("chainlink_program", {
        type: "string",
        description:
            "Chainlink verifier program ID (not required when --set_test_price_only)",
    })
    .option("chainlink_verifier_account", {
        type: "string",
        description:
            "Chainlink verifier state account (not required when --set_test_price_only)",
    })
    .option("chainlink_access_controller", {
        type: "string",
        description:
            "Chainlink access controller account (not required when --set_test_price_only)",
    })
    .option("feed_id", {
        type: "string",
        description:
            "32-byte feed ID as a 64-character hex string (no 0x prefix); not required when --set_test_price_only",
    })
    .option("price_scale", {
        type: "string",
        description:
            "Price scale factor matching Chainlink feed precision (e.g. 1000000000 for 1e9); also default for --test_price when omitted",
    })
    .option("price_max_staleness", {
        type: "number",
        description:
            "Maximum price staleness in seconds before deposit/redeem are rejected (e.g. 300); not required when --set_test_price_only",
    })
    .option("skip_if_exists", {
        type: "boolean",
        description:
            "If true, skip initialize_price_config when stake_price_config already exists",
        default: true,
    })
    .option("set_test_price", {
        type: "boolean",
        description:
            "After init (or when skipping init), call setPriceForTesting for localnet (requires program built with testing feature)",
        default: false,
    })
    .option("set_test_price_only", {
        type: "boolean",
        description:
            "Only call setPriceForTesting; skip initialize_price_config entirely (implies --set_test_price)",
        default: false,
    })
    .option("test_price", {
        type: "string",
        description:
            "i128 price written by setPriceForTesting (wYLDS per 1 staking unit, scaled by price_scale). Default: same as --price_scale (1:1 deposit)",
    })
    .option("test_price_timestamp", {
        type: "number",
        description: "Unix seconds for setPriceForTesting; default: current time",
    })
    .check((argv) => {
        const onlyTest = argv.set_test_price_only === true;
        const needInit = !onlyTest;
        if (needInit) {
            const missing: string[] = [];
            if (!argv.chainlink_program) missing.push("--chainlink_program");
            if (!argv.chainlink_verifier_account) {
                missing.push("--chainlink_verifier_account");
            }
            if (!argv.chainlink_access_controller) {
                missing.push("--chainlink_access_controller");
            }
            if (!argv.feed_id) missing.push("--feed_id");
            if (!argv.price_scale) missing.push("--price_scale");
            if (argv.price_max_staleness === undefined) {
                missing.push("--price_max_staleness");
            }
            if (missing.length > 0) {
                throw new Error(
                    `Missing required options for initialize: ${missing.join(", ")} (or use --set_test_price_only)`
                );
            }
        }
        if (onlyTest || argv.set_test_price) {
            if (!argv.price_scale && !argv.test_price) {
                throw new Error(
                    "Provide --test_price or --price_scale when using --set_test_price or --set_test_price_only"
                );
            }
        }
        return true;
    })
    .parseSync();

function selectProgram(pool: string): StakePriceProgram {
    if (pool === "auto") {
        return anchor.workspace.VaultStakeAuto as Program<VaultStakeAuto>;
    }
    return anchor.workspace.VaultStake as Program<VaultStake>;
}

async function main() {
    let provider: AnchorProvider;
    if (args.use_local_validator_config) {
        const cfg = readLocalValidatorConfig(args.local_validator_config);
        const rpc =
            process.env.ANCHOR_PROVIDER_URL ||
            process.env.RPC_URL ||
            cfg.rpcUrl ||
            "http://127.0.0.1:8899";
        const kp = keypairFromConfigSecret(cfg.upgradeAuthority.secretKey);
        const connection = new Connection(rpc, "confirmed");
        provider = new AnchorProvider(
            connection,
            new Wallet(kp),
            {commitment: "confirmed", preflightCommitment: "confirmed"}
        );
    } else {
        provider = AnchorProvider.env();
    }
    anchor.setProvider(provider);

    const program = selectProgram(String(args.pool));

    const [stakeConfigPda] = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from("stake_config")],
        program.programId
    );

    const [stakePriceConfigPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("stake_price_config"), stakeConfigPda.toBuffer()],
        program.programId
    );

    const BPF_LOADER_UPGRADEABLE_ID = new PublicKey(
        "BPFLoaderUpgradeab1e11111111111111111111111"
    );
    const [programData] = PublicKey.findProgramAddressSync(
        [program.programId.toBuffer()],
        BPF_LOADER_UPGRADEABLE_ID
    );

    const setTestPrice = args.set_test_price || args.set_test_price_only;
    const priceScaleForDefault = args.price_scale
        ? new BN(args.price_scale)
        : args.test_price
          ? new BN(args.test_price)
          : null;

    console.log("=== initialize_price_config / set_test_price (localnet) ===\n");
    console.log("Pool:                        ", args.pool);
    console.log("Program ID:                  ", program.programId.toBase58());
    console.log("Stake Config PDA:            ", stakeConfigPda.toBase58());
    console.log("Stake Price Config PDA:      ", stakePriceConfigPda.toBase58());
    console.log("Program Data PDA:            ", programData.toBase58());
    console.log("Signer (upgrade authority):  ", provider.wallet.publicKey.toBase58());
    console.log("set_test_price_only:         ", args.set_test_price_only);
    console.log("set_test_price:              ", setTestPrice);
    console.log();

    if (!args.set_test_price_only) {
        const chainlinkProgramId = new PublicKey(args.chainlink_program!);
        const chainlinkVerifierAccount = new PublicKey(
            args.chainlink_verifier_account!
        );
        const chainlinkAccessController = new PublicKey(
            args.chainlink_access_controller!
        );

        const feedIdHex = args.feed_id!.replace(/^0x/, "");
        if (feedIdHex.length !== 64) {
            throw new Error(
                `feed_id must be a 64-character hex string (32 bytes), got ${feedIdHex.length} characters`
            );
        }
        const feedIdBytes: number[] = Array.from(Buffer.from(feedIdHex, "hex"));

        const priceScale = new BN(args.price_scale!);
        const priceMaxStaleness = new BN(args.price_max_staleness!);

        console.log("Chainlink program:           ", chainlinkProgramId.toBase58());
        console.log("Chainlink verifier:          ", chainlinkVerifierAccount.toBase58());
        console.log("Chainlink access controller: ", chainlinkAccessController.toBase58());
        console.log("Feed ID (hex):               ", feedIdHex);
        console.log("Price scale:                 ", priceScale.toString());
        console.log("Max staleness (s):           ", args.price_max_staleness);
        console.log();

        const existing = await provider.connection.getAccountInfo(stakePriceConfigPda);

        if (existing && args.skip_if_exists) {
            console.log(
                "stake_price_config already exists; skipping initialize_price_config."
            );
        } else {
            const tx = await program.methods
                .initializePriceConfig(
                    chainlinkProgramId,
                    chainlinkVerifierAccount,
                    chainlinkAccessController,
                    feedIdBytes,
                    priceScale,
                    priceMaxStaleness
                )
                .accountsStrict({
                    stakeConfig: stakeConfigPda,
                    stakePriceConfig: stakePriceConfigPda,
                    signer: provider.wallet.publicKey,
                    programData: programData,
                    systemProgram: SystemProgram.programId,
                })
                .rpc();
            console.log("initialize_price_config transaction:", tx);
        }
    }

    if (setTestPrice) {
        const cfgInfo = await provider.connection.getAccountInfo(stakePriceConfigPda);
        if (!cfgInfo) {
            throw new Error(
                "stake_price_config account missing; run initialize_price_config first (without --set_test_price_only)"
            );
        }

        const testPriceBn = args.test_price
            ? new BN(args.test_price)
            : priceScaleForDefault!;
        const ts =
            args.test_price_timestamp !== undefined
                ? args.test_price_timestamp
                : Math.floor(Date.now() / 1000);

        console.log("setPriceForTesting price:      ", testPriceBn.toString());
        console.log("setPriceForTesting timestamp:", ts);
        console.log();

        const tx = await program.methods
            .setPriceForTesting(testPriceBn, new BN(ts))
            .accountsStrict({
                stakeConfig: stakeConfigPda,
                stakePriceConfig: stakePriceConfigPda,
                signer: provider.wallet.publicKey,
                programData: programData,
            })
            .rpc();
        console.log("setPriceForTesting transaction:", tx);
    }
}

main().catch(console.error);
