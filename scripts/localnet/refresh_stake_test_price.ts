/**
 * Localnet: bump StakePriceConfig.price_timestamp to "now" using setPriceForTesting.
 * Fixes PriceTooStale (6036) after wall-clock time exceeds price_max_staleness.
 *
 * Reuses the current on-chain price by default (pass --test_price to override).
 * Signer must be the program upgrade authority. Program must be built with
 * `cargo build --features testing` (or anchor equivalent) so the instruction exists.
 */

import * as anchor from "@coral-xyz/anchor";
import {AnchorProvider, Program, Wallet} from "@coral-xyz/anchor";
import BN from "bn.js";
import {Connection, PublicKey} from "@solana/web3.js";
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
        description: "prime = vault-stake; auto = vault-stake-auto",
    })
    .option("use_local_validator_config", {
        type: "boolean",
        default: false,
        description:
            "Sign with upgradeAuthority from scripts/.local-validator/config.json",
    })
    .option("local_validator_config", {
        type: "string",
        default: defaultLocalValidatorConfigPath(),
    })
    .option("test_price", {
        type: "string",
        description:
            "Override i128 price; default: keep existing value from StakePriceConfig",
    })
    .option("test_price_timestamp", {
        type: "number",
        description: "Unix seconds; default: current time",
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

    const onChain = await program.account.stakePriceConfig.fetch(
        stakePriceConfigPda
    );
    const priceBn = args.test_price
        ? new BN(args.test_price)
        : new BN(onChain.price.toString());
    if (priceBn.isZero()) {
        throw new Error(
            "On-chain price is 0. Run initialize_price_config with --set_test_price or pass --test_price."
        );
    }
    const ts =
        args.test_price_timestamp !== undefined
            ? args.test_price_timestamp
            : Math.floor(Date.now() / 1000);

    const maxStale = onChain.priceMaxStaleness.toNumber();
    console.log("=== refresh_stake_test_price (localnet) ===\n");
    console.log("Pool:              ", args.pool);
    console.log("Program:           ", program.programId.toBase58());
    console.log("Signer:            ", provider.wallet.publicKey.toBase58());
    console.log("Previous timestamp:", onChain.priceTimestamp.toString());
    console.log("New timestamp:     ", ts);
    console.log("Price (i128):      ", priceBn.toString());
    console.log("price_max_staleness (s):", maxStale);
    console.log();

    const tx = await program.methods
        .setPriceForTesting(priceBn, new BN(ts))
        .accountsStrict({
            stakeConfig: stakeConfigPda,
            stakePriceConfig: stakePriceConfigPda,
            signer: provider.wallet.publicKey,
            programData: programData,
        })
        .rpc();

    console.log("Transaction:", tx);
}

main().catch(console.error);
