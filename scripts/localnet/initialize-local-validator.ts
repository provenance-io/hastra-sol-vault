// scripts/initialize-local-validator.ts
import * as anchor from "@coral-xyz/anchor";
import {Program, Wallet} from "@coral-xyz/anchor";
import bs58 from "bs58";
import {
    Connection,
    Keypair,
    LAMPORTS_PER_SOL,
    PublicKey,
    SystemProgram,
} from "@solana/web3.js";
import {
    AuthorityType,
    createAccount,
    createMint,
    setAuthority,
    TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {VaultMint} from "../../target/types/vault_mint";
import {VaultStake} from "../../target/types/vault_stake";
import * as fs from "fs";
import * as path from "path";

const BPF_LOADER_UPGRADEABLE_ID = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");

async function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForConnection(connection: Connection, maxRetries = 30): Promise<void> {
    console.log("⏳ Waiting for validator to be ready...");
    for (let i = 0; i < maxRetries; i++) {
        try {
            await connection.getVersion();
            console.log("✅ Validator is ready!\n");
            return;
        } catch (error) {
            if (i === maxRetries - 1) {
                throw new Error("Failed to connect to validator after 30 attempts");
            }
            await sleep(1000);
        }
    }
}

async function airdrop(
    connection: Connection,
    publicKey: PublicKey,
    amount: number
): Promise<void> {
    const signature = await connection.requestAirdrop(
        publicKey,
        amount * LAMPORTS_PER_SOL
    );

    const latestBlockhash = await connection.getLatestBlockhash();
    await connection.confirmTransaction({
        signature,
        blockhash: latestBlockhash.blockhash,
        lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
    });

    console.log(`  ✅ Airdropped ${amount} SOL to ${publicKey.toBase58().slice(0, 8)}...`);
}

async function main() {
    // Setup provider
    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);
    const upgradeAuthority = (provider.wallet as Wallet).payer;

    console.log("=".repeat(80));
    console.log("🚀 HASTRA SOLANA VAULT - LOCAL VALIDATOR INITIALIZATION");
    console.log("=".repeat(80));
    console.log();

    // Connect to local validator
    const connection = new Connection("http://127.0.0.1:8899", "confirmed");

    // Wait for validator to be ready
    await waitForConnection(connection);

    // Generate keypairs
    console.log("📝 Generating admin keypairs...");
    const vaultTokenAccountOwner = Keypair.generate();
    const rewardsAdmin = Keypair.generate();
    const freezeAdmin = Keypair.generate();

    console.log("  Upgrade Authority:       ", upgradeAuthority.publicKey.toBase58());
    console.log("  Rewards Admin:           ", rewardsAdmin.publicKey.toBase58());
    console.log("  Freeze Admin:            ", freezeAdmin.publicKey.toBase58());
    console.log("  Vault Token AccountOwner:", vaultTokenAccountOwner.publicKey.toBase58());
    console.log();

    // Airdrop SOL to all keypairs
    console.log("💰 Airdropping SOL to admin accounts...");
    await airdrop(connection, upgradeAuthority.publicKey, 100);
    await airdrop(connection, rewardsAdmin.publicKey, 50);
    await airdrop(connection, freezeAdmin.publicKey, 50);
    console.log();

    // Load programs
    console.log("📦 Loading programs...");
    const mintProgram = anchor.workspace.VaultMint as Program<VaultMint>;
    const stakeProgram = anchor.workspace.VaultStake as Program<VaultStake>;

    console.log("  Vault-Mint Program: ", mintProgram.programId.toBase58());
    console.log("  Vault-Stake Program:", stakeProgram.programId.toBase58());
    console.log();

    // Create tokens
    console.log("🪙 Creating SPL tokens...");

    const usdcToken = await createMint(
        connection,
        upgradeAuthority,
        upgradeAuthority.publicKey,
        null,
        6, // 6 decimals like USDC
        undefined,
        undefined,
        TOKEN_PROGRAM_ID
    );
    console.log("  Vault Token (USDC):  ", usdcToken.toBase58());

    const wyldsToken = await createMint(
        connection,
        upgradeAuthority,
        upgradeAuthority.publicKey,
        upgradeAuthority.publicKey,
        6,
        undefined,
        undefined,
        TOKEN_PROGRAM_ID
    );
    console.log("  Mint Token (wYLDS):  ", wyldsToken.toBase58());

    const primeToken = await createMint(
        connection,
        upgradeAuthority,
        upgradeAuthority.publicKey,
        upgradeAuthority.publicKey,
        6,
        undefined,
        undefined,
        TOKEN_PROGRAM_ID
    );
    console.log("  Stake Token (PRIME): ", primeToken.toBase58());
    console.log();

    // Derive PDAs for Mint Program
    console.log("🔐 Deriving Mint Program PDAs...");

    const [mintConfigPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("config")],
        mintProgram.programId
    );

    const [mintAuthority] = PublicKey.findProgramAddressSync(
        [Buffer.from("mint_authority")],
        mintProgram.programId
    );

    const [freezeAuthority] = PublicKey.findProgramAddressSync(
        [Buffer.from("freeze_authority")],
        mintProgram.programId
    );

    const [vaultAuthority] = PublicKey.findProgramAddressSync(
        [Buffer.from("vault_authority")],
        mintProgram.programId
    );

    const [redeemVaultAuthority] = PublicKey.findProgramAddressSync(
        [Buffer.from("redeem_vault_authority")],
        mintProgram.programId
    );

    console.log("  Config PDA:              ", mintConfigPda.toBase58());
    console.log("  Mint Authority:          ", mintAuthority.toBase58());
    console.log("  Freeze Authority:        ", freezeAuthority.toBase58());
    console.log("  Vault Authority:         ", vaultAuthority.toBase58());
    console.log("  Redeem Vault Authority:  ", redeemVaultAuthority.toBase58());
    console.log();

    // Create token accounts for Mint Program
    console.log("💼 Creating Mint Program token accounts...");

    const vaultTokenAccount = await createAccount(
        connection,
        upgradeAuthority,
        usdcToken,
        vaultTokenAccountOwner.publicKey
    );
    console.log("  Vault Token Account:        ", vaultTokenAccount.toBase58());

    const redeemVaultTokenAccount = await createAccount(
        connection,
        upgradeAuthority,
        usdcToken,
        upgradeAuthority.publicKey
    );
    console.log("  Redeem Vault Token Account: ", redeemVaultTokenAccount.toBase58());
    console.log();

    // Initialize Mint Program
    console.log("⚙️  Initializing Mint Program...");

    try {
        const [programDataPda] = PublicKey.findProgramAddressSync(
            [mintProgram.programId.toBuffer()],
            BPF_LOADER_UPGRADEABLE_ID
        );

        const tx = await mintProgram.methods
            .initialize(
                [freezeAdmin.publicKey],
                [rewardsAdmin.publicKey],
                stakeProgram.programId
            )
            .accounts({
                signer: upgradeAuthority.publicKey,
                vaultTokenAccount: vaultTokenAccount,
                vaultTokenMint: usdcToken,
                redeemVaultTokenAccount: redeemVaultTokenAccount,
                mint: wyldsToken,
                programData: programDataPda,
            })
            .signers([upgradeAuthority])
            .rpc();

        console.log("  ✅ Mint Program initialized");
        console.log("  Transaction:", tx);
    } catch (error) {
        console.error("  ❌ Failed to initialize Mint Program:", error);
        throw error;
    }
    console.log();

    // Transfer mint and freeze authority to PDAs
    console.log("🔄 Transferring mint token authorities to PDAs...");

    await setAuthority(
        connection,
        upgradeAuthority,
        wyldsToken,
        upgradeAuthority.publicKey,
        AuthorityType.MintTokens,
        mintAuthority,
        undefined,
        undefined,
        TOKEN_PROGRAM_ID
    );
    console.log("  ✅ Transferred mint authority to PDA");

    await setAuthority(
        connection,
        upgradeAuthority,
        wyldsToken,
        upgradeAuthority.publicKey,
        AuthorityType.FreezeAccount,
        freezeAuthority,
        undefined,
        undefined,
        TOKEN_PROGRAM_ID
    );
    console.log("  ✅ Transferred freeze authority to PDA");
    console.log();

    // Derive PDAs for Stake Program
    console.log("🔐 Deriving Stake Program PDAs...");

    const [stakeConfigPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("stake_config")],
        stakeProgram.programId
    );

    const [stakeMintAuthority] = PublicKey.findProgramAddressSync(
        [Buffer.from("mint_authority")],
        stakeProgram.programId
    );

    const [stakeFreezeAuthority] = PublicKey.findProgramAddressSync(
        [Buffer.from("freeze_authority")],
        stakeProgram.programId
    );

    const [stakeVaultAuthority] = PublicKey.findProgramAddressSync(
        [Buffer.from("vault_authority")],
        stakeProgram.programId
    );

    console.log("  Stake Config PDA:        ", stakeConfigPda.toBase58());
    console.log("  Stake Mint Authority:    ", stakeMintAuthority.toBase58());
    console.log("  Stake Freeze Authority:  ", stakeFreezeAuthority.toBase58());
    console.log("  Stake Vault Authority:   ", stakeVaultAuthority.toBase58());
    console.log();

    // Create token account for Stake Program
    console.log("💼 Creating Stake Program token account...");

    const stakeVaultTokenAccount = await createAccount(
        connection,
        upgradeAuthority,
        wyldsToken,
        upgradeAuthority.publicKey,
    );
    console.log("  Stake Vault Token Account:", stakeVaultTokenAccount.toBase58());
    console.log();

    // Initialize Stake Program
    console.log("⚙️  Initializing Stake Program...");

    const unbondingPeriod = new anchor.BN(120); // 2 minutes

    try {
        const [programDataPda] = PublicKey.findProgramAddressSync(
            [stakeProgram.programId.toBuffer()],
            BPF_LOADER_UPGRADEABLE_ID
        );

        const tx = await stakeProgram.methods
            .initialize(
                unbondingPeriod,
                [freezeAdmin.publicKey],
                [rewardsAdmin.publicKey]
            )
            .accountsStrict({
                stakeConfig: stakeConfigPda,
                vaultAuthority: stakeVaultAuthority,
                vaultTokenAccount: stakeVaultTokenAccount,
                vaultTokenMint: wyldsToken,
                mint: primeToken,
                signer: upgradeAuthority.publicKey,
                tokenProgram: TOKEN_PROGRAM_ID,
                systemProgram: SystemProgram.programId,
                programData: programDataPda,
            })
            .signers([upgradeAuthority])
            .rpc();

        console.log("  ✅ Stake Program initialized");
        console.log("  Transaction:", tx);
    } catch (error) {
        console.error("  ❌ Failed to initialize Stake Program:", error);
        throw error;
    }
    console.log();

    // Transfer stake token authorities to PDAs
    console.log("🔄 Transferring stake token authorities to PDAs...");

    await setAuthority(
        connection,
        upgradeAuthority,
        primeToken,
        upgradeAuthority.publicKey,
        AuthorityType.MintTokens,
        stakeMintAuthority,
        undefined,
        undefined,
        TOKEN_PROGRAM_ID
    );
    console.log("  ✅ Transferred stake mint authority to PDA");

    await setAuthority(
        connection,
        upgradeAuthority,
        primeToken,
        upgradeAuthority.publicKey,
        AuthorityType.FreezeAccount,
        stakeFreezeAuthority,
        undefined,
        undefined,
        TOKEN_PROGRAM_ID
    );
    console.log("  ✅ Transferred stake freeze authority to PDA");
    console.log();

    // Save configuration
    console.log("💾 Saving configuration files...");

    const configDir = path.join(__dirname, "..", ".local-validator");
    if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, {recursive: true});
    }

    const jsonConfig = {
        network: "localnet",
        rpcUrl: "http://127.0.0.1:8899",
        timestamp: new Date().toISOString(),

        upgradeAuthority: {
            publicKey: upgradeAuthority.publicKey.toBase58(),
            secretKey: bs58.encode(Buffer.from(upgradeAuthority.secretKey)),
        },
        rewardsAdmin: {
            publicKey: rewardsAdmin.publicKey.toBase58(),
            secretKey: bs58.encode(Buffer.from(rewardsAdmin.secretKey)),
        },
        freezeAdmin: {
            publicKey: freezeAdmin.publicKey.toBase58(),
            secretKey: bs58.encode(Buffer.from(freezeAdmin.secretKey)),
        },

        tokens: {
            usdcToken: usdcToken.toBase58(),
            wyldsToken: wyldsToken.toBase58(),
            primeToken: primeToken.toBase58(),
        },

        mintProgram: {
            programId: mintProgram.programId.toBase58(),
            configPda: mintConfigPda.toBase58(),
            mintAuthority: mintAuthority.toBase58(),
            freezeAuthority: freezeAuthority.toBase58(),
            vaultAuthority: vaultAuthority.toBase58(),
            redeemVaultAuthority: redeemVaultAuthority.toBase58(),
            vaultTokenAccount: vaultTokenAccount.toBase58(),
            redeemVaultTokenAccount: redeemVaultTokenAccount.toBase58(),
        },

        stakeProgram: {
            programId: stakeProgram.programId.toBase58(),
            configPda: stakeConfigPda.toBase58(),
            mintAuthority: stakeMintAuthority.toBase58(),
            freezeAuthority: stakeFreezeAuthority.toBase58(),
            vaultAuthority: stakeVaultAuthority.toBase58(),
            vaultTokenAccount: stakeVaultTokenAccount.toBase58(),
            unbondingPeriod: unbondingPeriod.toNumber(),
        },
    };

    const configPath = path.join(configDir, "config.json");
    fs.writeFileSync(configPath, JSON.stringify(jsonConfig, null, 2));
    console.log("  ✅ JSON config:", configPath);

    // Save environment variables
    const envPath = path.join(configDir, ".env");
    const envContent = `# Hastra Solana Vault - Local Validator Configuration
# Generated: ${new Date().toISOString()}

SOLANA_NETWORK=localnet
RPC_URL=http://127.0.0.1:8899

# Admin Accounts
UPGRADE_AUTHORITY=${upgradeAuthority.publicKey.toBase58()}
REWARDS_ADMIN=${rewardsAdmin.publicKey.toBase58()}
FREEZE_ADMIN=${freezeAdmin.publicKey.toBase58()}

# Tokens
VAULT_TOKEN=${usdcToken.toBase58()}
MINT_TOKEN=${wyldsToken.toBase58()}
STAKE_TOKEN=${primeToken.toBase58()}

# Mint Program
MINT_PROGRAM_ID=${mintProgram.programId.toBase58()}
MINT_CONFIG_PDA=${mintConfigPda.toBase58()}
VAULT_TOKEN_ACCOUNT=${vaultTokenAccount.toBase58()}
REDEEM_VAULT_TOKEN_ACCOUNT=${redeemVaultTokenAccount.toBase58()}

# Stake Program
STAKE_PROGRAM_ID=${stakeProgram.programId.toBase58()}
STAKE_CONFIG_PDA=${stakeConfigPda.toBase58()}
STAKE_VAULT_TOKEN_ACCOUNT=${stakeVaultTokenAccount.toBase58()}
UNBONDING_PERIOD=${unbondingPeriod.toNumber()}`;

    fs.writeFileSync(envPath, envContent);
    console.log("  ✅ Environment file:", envPath);
    console.log();

    // Print summary
    console.log("=".repeat(80));
    console.log("🎉 INITIALIZATION COMPLETE!");
    console.log("=".repeat(80));
    console.log();
    console.log("📋 Quick Reference:");
    console.log();
    console.log("Admin Accounts:");
    console.log(`  Upgrade Authority: ${upgradeAuthority.publicKey.toBase58()}`);
    console.log(`  Rewards Admin:     ${rewardsAdmin.publicKey.toBase58()}`);
    console.log(`  Freeze Admin:      ${freezeAdmin.publicKey.toBase58()}`);
    console.log();
    console.log("Tokens:");
    console.log(`  USDC (vault):  ${usdcToken.toBase58()}`);
    console.log(`  wYLDS (mint):  ${wyldsToken.toBase58()}`);
    console.log(`  PRIME (stake): ${primeToken.toBase58()}`);
    console.log();
    console.log("Programs:");
    console.log(`  Vault-Mint:  ${mintProgram.programId.toBase58()}`);
    console.log(`  Vault-Stake: ${stakeProgram.programId.toBase58()}`);
    console.log();
    console.log("🌐 Next Steps:");
    console.log("  1. See detailed configs from scripts/.local-validator/*");
    console.log();
    console.log("=".repeat(80));
}

main()
    .then(() => {
        console.log("\n✅ Script completed successfully");
        process.exit(0);
    })
    .catch((error) => {
        console.error("\n❌ Script failed:", error);
        process.exit(1);
    });
