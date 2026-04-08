import * as multisig from "@squads-protocol/multisig";
import {
    PublicKey,
    SystemProgram,
    TransactionMessage,
    VersionedTransaction,
} from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import BN from "bn.js";
import { VaultStakeAuto } from "../../target/types/vault_stake_auto";
import yargs from "yargs";

const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);

const program = anchor.workspace.VaultStakeAuto as Program<VaultStakeAuto>;

const BPF_LOADER_UPGRADEABLE_ID = new PublicKey(
    "BPFLoaderUpgradeab1e11111111111111111111111"
);

const args = yargs(process.argv.slice(2))
    .option("multisig_pda", {
        type: "string",
        description: "Squads multisig account address",
        required: true,
    })
    .option("chainlink_program", {
        type: "string",
        description: "Chainlink verifier program ID",
        required: true,
    })
    .option("chainlink_access_controller", {
        type: "string",
        description: "Chainlink access controller account",
        required: true,
    })
    .option("feed_id", {
        type: "string",
        description: "32-byte feed ID as a 64-character hex string (no 0x prefix)",
        required: true,
    })
    .option("price_scale", {
        type: "string",
        description: "Price scale factor matching Chainlink feed precision (e.g. 1000000000000000000 for 1e18)",
        required: true,
    })
    .option("price_max_staleness", {
        type: "number",
        description: "Maximum price staleness in seconds before deposit/redeem are rejected (e.g. 300)",
        required: true,
    })
    .option("vault_pda", {
        type: "string",
        description: "Override the Squads-derived vault PDA (needed when the multisig is Squads v3 or when the upgrade authority differs from the SDK-derived vault)",
        required: false,
    })
    .option("transaction_index", {
        type: "string",
        description: "Override the next transaction index read from the multisig account (needed when offset-78 gives garbage, e.g. for Squads v3 accounts)",
        required: false,
    })
    .parseSync();

async function main() {
    const msPDA = new PublicKey(args.multisig_pda);
    const connection = provider.connection;
    const member = provider.wallet.payer;

    // Derive PDAs
    const [stakeConfigPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("stake_config")],
        program.programId
    );

    const [stakePriceConfigPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("stake_price_config"), stakeConfigPda.toBuffer()],
        program.programId
    );

    const [programData] = PublicKey.findProgramAddressSync(
        [program.programId.toBuffer()],
        BPF_LOADER_UPGRADEABLE_ID
    );

    // Vault PDA — honour explicit override, fall back to SDK derivation.
    // Use --vault_pda when the multisig is Squads v3 (SMPLec...) or when the
    // program upgrade authority differs from the SDK-derived vault.
    const [vaultPdaDerived] = multisig.getVaultPda({ multisigPda: msPDA, index: 0 });
    const vaultPda = args.vault_pda ? new PublicKey(args.vault_pda) : vaultPdaDerived;

    // Parse and validate feed_id
    const feedIdHex = args.feed_id.replace(/^0x/, "");
    if (feedIdHex.length !== 64) {
        throw new Error(
            `feed_id must be a 64-character hex string (32 bytes), got ${feedIdHex.length} characters`
        );
    }
    const chainlinkProgramId = new PublicKey(args.chainlink_program);
    const [chainlinkVerifierPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("verifier")],
        chainlinkProgramId
    );

    const feedIdBytes: number[] = Array.from(Buffer.from(feedIdHex, "hex"));

    // Transaction index — honour explicit override, fall back to reading the
    // Squads v4 multisig account data (u64 at byte offset 78).
    // Use --transaction_index when the multisig is Squads v3 or the auto-read
    // value appears wrong (offset 78 holds different data in v3 accounts).
    let transactionIndex: bigint;
    if (args.transaction_index !== undefined) {
        transactionIndex = BigInt(args.transaction_index);
    } else {
        const accountInfo = await connection.getAccountInfo(msPDA);
        if (!accountInfo) throw new Error(`Multisig account not found: ${msPDA.toBase58()}`);
        transactionIndex = accountInfo.data.readBigUInt64LE(78) + BigInt(1);
    }

    console.log("=== initialize_price_config Squads Proposal ===\n");
    console.log("Program ID:              ", program.programId.toBase58());
    console.log("Multisig PDA:            ", msPDA.toBase58());
    console.log("Vault PDA (signer):      ", vaultPda.toBase58());
    console.log("Stake Config PDA:        ", stakeConfigPda.toBase58());
    console.log("Stake Price Config PDA:  ", stakePriceConfigPda.toBase58());
    console.log("Program Data:            ", programData.toBase58());
    console.log("Proposal index:          ", transactionIndex.toString());
    console.log("Chainlink program:       ", args.chainlink_program);
    console.log("Chainlink verifier:      ", chainlinkVerifierPda.toBase58());
    console.log("Access controller:       ", args.chainlink_access_controller);
    console.log("Feed ID (hex):           ", feedIdHex);
    console.log("Price scale:             ", args.price_scale);
    console.log("Max staleness (s):       ", args.price_max_staleness);
    console.log();

    // Build the initialize_price_config instruction.
    // The vault PDA is set as signer — when Squads executes the proposal it
    // co-signs the inner TransactionMessage as the vault PDA, satisfying
    // validate_program_update_authority.
    const ix = await program.methods
        .initializePriceConfig(
            new PublicKey(args.chainlink_program),
            chainlinkVerifierPda,
            new PublicKey(args.chainlink_access_controller),
            feedIdBytes,
            new BN(args.price_scale),
            new BN(args.price_max_staleness),
        )
        .accountsStrict({
            stakeConfig: stakeConfigPda,
            stakePriceConfig: stakePriceConfigPda,
            signer: vaultPda,
            programData: programData,
            systemProgram: SystemProgram.programId,
        })
        .instruction();

    // Inner TransactionMessage — payerKey is vault PDA so it covers rent for
    // the new StakePriceConfig account and signs as upgrade authority.
    const innerTxMessage = new TransactionMessage({
        payerKey: vaultPda,
        recentBlockhash: (await connection.getLatestBlockhash()).blockhash,
        instructions: [ix],
    });

    // Create the Squads vault transaction and proposal in a single outer tx.
    const ix1 = multisig.instructions.vaultTransactionCreate({
        multisigPda: msPDA,
        transactionIndex,
        creator: member.publicKey,
        vaultIndex: 0,
        ephemeralSigners: 0,
        transactionMessage: innerTxMessage,
    });

    const ix2 = multisig.instructions.proposalCreate({
        multisigPda: msPDA,
        transactionIndex,
        creator: member.publicKey,
    });

    const { blockhash } = await connection.getLatestBlockhash();
    const tx = new VersionedTransaction(
        new TransactionMessage({
            payerKey: member.publicKey,
            recentBlockhash: blockhash,
            instructions: [ix1, ix2],
        }).compileToV0Message()
    );
    tx.sign([member]);

    const sig = await connection.sendTransaction(tx);

    console.log(`✅ Proposal #${transactionIndex} submitted`);
    console.log(`   Transaction: ${sig}`);
    console.log(`\n   Next steps:`);
    console.log(`   1. Squad members approve at https://app.squads.so`);
    console.log(`   2. Once the approval threshold is met, execute the proposal`);
    console.log(`   3. After execution, call verify_price to seed the initial Chainlink price`);
}

main().catch(console.error);
