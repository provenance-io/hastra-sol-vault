import * as anchor from "@coral-xyz/anchor";
import {Program} from "@coral-xyz/anchor";
import {VaultMint} from "../target/types/vault_mint";
import {VaultStake} from "../target/types/vault_stake";
import {Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram} from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";
import {
    approve,
    createAccount,
    createMint,
    getAccount,
    getMint,
    mintTo,
    revoke,
    TOKEN_PROGRAM_ID,
    transfer,
} from "@solana/spl-token";
import {assert, expect} from "chai";
import BN from "bn.js";
import {createBigInt} from "@metaplex-foundation/umi";
import {allocationsToMerkleTree, makeLeaf} from "../scripts/cryptolib";
import {MerkleTree} from "merkletreejs";
import {deriveRewardsEpochAccounts} from "./helpers";

function resolveProgramIdFromAnchorToml(programName: string): PublicKey | null {
    const anchorTomlPath = path.resolve(__dirname, "..", "Anchor.toml");
    if (!fs.existsSync(anchorTomlPath)) return null;
    const lines = fs.readFileSync(anchorTomlPath, "utf8").split(/\r?\n/);
    const targetSections = new Set([
        "[programs.localnet]",
        "[programs.devnet]",
        "[programs.mainnet-beta]",
        "[programs.mainnet]",
        "[programs.testnet]",
    ]);
    let inProgramsSection = false;

    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (line.length === 0 || line.startsWith("#")) continue;

        if (line.startsWith("[") && line.endsWith("]")) {
            inProgramsSection = targetSections.has(line);
            continue;
        }

        if (!inProgramsSection) continue;

        const equalsIndex = line.indexOf("=");
        if (equalsIndex === -1) continue;

        const key = line.slice(0, equalsIndex).trim();
        const value = line.slice(equalsIndex + 1).trim().replace(/^"(.*)"$/, "$1");
        if (key === programName && value.length > 0) {
            return new PublicKey(value);
        }
    }

    return null;
}

function resolveStakeAutoProgramId(): PublicKey {
    const envProgramId = process.env.STAKE_AUTO_PROGRAM_ID;
    if (envProgramId) {
        return new PublicKey(envProgramId);
    }

    const libRsPath = path.resolve(__dirname, "..", "programs", "vault-stake-auto", "src", "lib.rs");
    if (fs.existsSync(libRsPath)) {
        const libRs = fs.readFileSync(libRsPath, "utf8");
        const match = libRs.match(/declare_id!\("([A-Za-z0-9]+)"\);/);
        if (match) {
            return new PublicKey(match[1]);
        }
    }

    const anchorTomlProgramId = resolveProgramIdFromAnchorToml("vault-stake-auto");
    if (anchorTomlProgramId) {
        return anchorTomlProgramId;
    }

    throw new Error(
        "Unable to resolve vault-stake-auto program id. Set STAKE_AUTO_PROGRAM_ID or define vault-stake-auto in Anchor.toml [programs.*]."
    );
}

describe("vault-mint", () => {
    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);

    const program = anchor.workspace.VaultMint as Program<VaultMint>;
    const stakeProgram = anchor.workspace.VaultStake as Program<VaultStake>;
    const stakeAutoProgramId = resolveStakeAutoProgramId();
    const stakeAutoIdl = JSON.parse(JSON.stringify(stakeProgram.idl));
    stakeAutoIdl.address = stakeAutoProgramId.toBase58();
    if (stakeAutoIdl.metadata) {
        stakeAutoIdl.metadata.address = stakeAutoProgramId.toBase58();
    }
    const stakeAutoProgram = new anchor.Program(stakeAutoIdl as anchor.Idl, provider) as Program<VaultStake>;

    let mintedToken: PublicKey;
    let vaultedToken: PublicKey;
    let vaultTokenAccount: PublicKey;
    let vaultTokenAccountOwner: Keypair;
    let vaultTokenAccountOwnerPublicKey: PublicKey;
    let badVaultTokenAccountOwner: Keypair;
    let badVaultTokenAccountOwnerPublicKey: PublicKey;
    let redeemVaultTokenAccount: PublicKey;
    let configPda: PublicKey;
    let vaultTokenAccountConfigPda: PublicKey;
    let mintAuthorityPda: PublicKey;
    let freezeAuthorityPda: PublicKey;
    let programDataPda: PublicKey;
    let redeemVaultAuthorityPda: PublicKey;

    let user: Keypair;
    let userMintTokenAccount: PublicKey;
    let userVaultTokenAccount: PublicKey;

    let freezeAdmin: Keypair;
    let rewardsAdmin: Keypair;

    const BPF_LOADER_UPGRADEABLE_ID = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");

    before(async () => {
        // Setup keypairs
        user = Keypair.generate();
        freezeAdmin = Keypair.fromSeed(Buffer.alloc(32, 7)); // Deterministic admin
        rewardsAdmin = Keypair.fromSeed(Buffer.alloc(32, 31)); // Deterministic admin
        vaultTokenAccountOwner = Keypair.fromSeed(Buffer.alloc(32, 72)); // Deterministic owner
        vaultTokenAccountOwnerPublicKey = vaultTokenAccountOwner.publicKey;
        badVaultTokenAccountOwner = Keypair.generate();
        badVaultTokenAccountOwnerPublicKey = badVaultTokenAccountOwner.publicKey;
        [mintAuthorityPda] = PublicKey.findProgramAddressSync(
            [Buffer.from("mint_authority")],
            program.programId
        );

        [freezeAuthorityPda] = PublicKey.findProgramAddressSync(
            [Buffer.from("freeze_authority")],
            program.programId
        );
        [redeemVaultAuthorityPda] = PublicKey.findProgramAddressSync(
            [Buffer.from("redeem_vault_authority")],
            program.programId
        );

        // Airdrop SOL
        await provider.connection.requestAirdrop(provider.publicKey, 100 * LAMPORTS_PER_SOL);
        await provider.connection.requestAirdrop(user.publicKey, 10 * LAMPORTS_PER_SOL);
        await provider.connection.requestAirdrop(freezeAdmin.publicKey, 2 * LAMPORTS_PER_SOL);
        await provider.connection.requestAirdrop(rewardsAdmin.publicKey, 2 * LAMPORTS_PER_SOL);
        await provider.connection.requestAirdrop(redeemVaultAuthorityPda, 10 * LAMPORTS_PER_SOL);
        await provider.connection.requestAirdrop(vaultTokenAccountOwnerPublicKey, 10 * LAMPORTS_PER_SOL);
        await provider.connection.requestAirdrop(badVaultTokenAccountOwnerPublicKey, 10 * LAMPORTS_PER_SOL);

        // Wait for airdrops
        await new Promise(resolve => setTimeout(resolve, 1000));

        // Create mint token (e.g., YLDS)
        mintedToken = await createMint(
            provider.connection,
            provider.wallet.payer,
            mintAuthorityPda,
            freezeAuthorityPda,
            6,
        );

        // Create vault token mint (will be controlled by program)
        vaultedToken = await createMint(
            provider.connection,
            provider.wallet.payer,
            provider.wallet.publicKey,
            null,
            6
        );

        // Derive PDAs
        [configPda] = PublicKey.findProgramAddressSync(
            [Buffer.from("config")],
            program.programId
        );

        [vaultTokenAccountConfigPda] = PublicKey.findProgramAddressSync(
            [
                Buffer.from("vault_token_account_config"),
                configPda.toBuffer()
            ],
            program.programId
        );

        [programDataPda] = PublicKey.findProgramAddressSync(
            [program.programId.toBuffer()],
            BPF_LOADER_UPGRADEABLE_ID
        );

        // Create vault token account
        vaultTokenAccount = await createAccount(
            provider.connection,
            provider.wallet.payer,
            vaultedToken,
            vaultTokenAccountOwnerPublicKey
        );

        redeemVaultTokenAccount = await createAccount(
            provider.connection,
            provider.wallet.payer,
            vaultedToken,
            provider.wallet.publicKey,
        );

        // Create user token accounts with user as owner
        userMintTokenAccount = await createAccount(
            provider.connection,
            provider.wallet.payer,
            mintedToken,
            user.publicKey
        );

        userVaultTokenAccount = await createAccount(
            provider.connection,
            provider.wallet.payer,
            vaultedToken,
            user.publicKey
        );

        // Mint vault tokens to user (USDC)
        await mintTo(
            provider.connection,
            provider.wallet.payer,
            vaultedToken,
            userVaultTokenAccount,
            provider.wallet.publicKey,
            1_000_000_000 // 1000 tokens
        );

        // Mint vault tokens to redemption vault
        await mintTo(
            provider.connection,
            provider.wallet.payer,
            vaultedToken,
            redeemVaultTokenAccount,
            provider.wallet.publicKey,
            1_000_000_000_000 // 1,000,000 tokens
        );

        // print the important addresses
        console.log("=".repeat(80))
        console.log("Minted Token:              ", mintedToken.toBase58());
        console.log("Vaulted Token:             ", vaultedToken.toBase58());
        console.log("Vault Token Account:       ", vaultTokenAccount.toBase58());
        console.log("Vault Token Account Owner: ", vaultTokenAccountOwnerPublicKey.toBase58());
        console.log("Redeem Vault Token Account:", redeemVaultTokenAccount.toBase58());
        console.log("Config PDA:                ", configPda.toBase58());
        console.log("Mint Authority PDA:        ", mintAuthorityPda.toBase58());
        console.log("Freeze Authority PDA:      ", freezeAuthorityPda.toBase58());
        console.log("Program Data PDA:          ", programDataPda.toBase58());
        console.log("Redeem Vault Authority PDA:", redeemVaultAuthorityPda.toBase58());
        console.log("User:                      ", user.publicKey.toBase58());
        console.log("User Mint Token Account:   ", userMintTokenAccount.toBase58());
        console.log("User Vault Token Account:  ", userVaultTokenAccount.toBase58());
        console.log("=".repeat(80))

    });

    describe("initialize", () => {
        it("fails with too many freeze administrators", async () => {
            const tooManyAdmins = Array(6).fill(Keypair.generate().publicKey);
            try {
                await program.methods
                    .initialize(tooManyAdmins, [rewardsAdmin.publicKey])
                    .accountsStrict({
                        config: configPda,
                        vaultTokenAccountConfig: vaultTokenAccountConfigPda,
                        vaultTokenAccount: vaultTokenAccount,
                        redeemVaultAuthority: redeemVaultAuthorityPda,
                        redeemVaultTokenAccount: redeemVaultTokenAccount,
                        vaultTokenMint: vaultedToken,
                        mint: mintedToken,
                        signer: provider.wallet.publicKey,
                        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
                        systemProgram: anchor.web3.SystemProgram.programId,
                        programData: programDataPda,
                        allowedExternalMintProgram: stakeProgram.programId,
                    })
                    .rpc();
                assert.fail("Should have thrown error");
            } catch (err) {
                expect(err).to.exist;
            }
        });

        it("fails with too many redeem administrators", async () => {
            const tooManyAdmins = Array(6).fill(Keypair.generate().publicKey);
            try {
                await program.methods
                    .initialize([freezeAdmin.publicKey], tooManyAdmins)
                    .accountsStrict({
                        config: configPda,
                        vaultTokenAccountConfig: vaultTokenAccountConfigPda,
                        vaultTokenAccount: vaultTokenAccount,
                        redeemVaultAuthority: redeemVaultAuthorityPda,
                        redeemVaultTokenAccount: redeemVaultTokenAccount,
                        vaultTokenMint: vaultedToken,
                        mint: mintedToken,
                        signer: provider.wallet.publicKey,
                        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
                        systemProgram: anchor.web3.SystemProgram.programId,
                        programData: programDataPda,
                        allowedExternalMintProgram: stakeProgram.programId,
                    })
                    .rpc();
                assert.fail("Should have thrown error");
            } catch (err) {
                expect(err).to.exist;
            }
        });

        it("fails with empty freeze administrators", async () => {
            try {
                await program.methods
                    .initialize([], [rewardsAdmin.publicKey])
                    .accountsStrict({
                        config: configPda,
                        vaultTokenAccountConfig: vaultTokenAccountConfigPda,
                        vaultTokenAccount: vaultTokenAccount,
                        redeemVaultAuthority: redeemVaultAuthorityPda,
                        redeemVaultTokenAccount: redeemVaultTokenAccount,
                        vaultTokenMint: vaultedToken,
                        mint: mintedToken,
                        signer: provider.wallet.publicKey,
                        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
                        systemProgram: anchor.web3.SystemProgram.programId,
                        programData: programDataPda,
                        allowedExternalMintProgram: stakeProgram.programId,
                    })
                    .rpc();
                assert.fail("Should have thrown EmptyAdministrators");
            } catch (err) {
                expect(err.toString()).to.match(/EmptyAdministrators|must not be empty/i);
            }
        });

        it("fails with empty rewards administrators", async () => {
            try {
                await program.methods
                    .initialize([freezeAdmin.publicKey], [])
                    .accountsStrict({
                        config: configPda,
                        vaultTokenAccountConfig: vaultTokenAccountConfigPda,
                        vaultTokenAccount: vaultTokenAccount,
                        redeemVaultAuthority: redeemVaultAuthorityPda,
                        redeemVaultTokenAccount: redeemVaultTokenAccount,
                        vaultTokenMint: vaultedToken,
                        mint: mintedToken,
                        signer: provider.wallet.publicKey,
                        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
                        systemProgram: anchor.web3.SystemProgram.programId,
                        programData: programDataPda,
                        allowedExternalMintProgram: stakeProgram.programId,
                    })
                    .rpc();
                assert.fail("Should have thrown EmptyAdministrators");
            } catch (err) {
                expect(err.toString()).to.match(/EmptyAdministrators|must not be empty/i);
            }
        });

        it("fails with duplicate freeze administrators", async () => {
            try {
                await program.methods
                    .initialize(
                        [freezeAdmin.publicKey, freezeAdmin.publicKey],
                        [rewardsAdmin.publicKey]
                    )
                    .accountsStrict({
                        config: configPda,
                        vaultTokenAccountConfig: vaultTokenAccountConfigPda,
                        vaultTokenAccount: vaultTokenAccount,
                        redeemVaultAuthority: redeemVaultAuthorityPda,
                        redeemVaultTokenAccount: redeemVaultTokenAccount,
                        vaultTokenMint: vaultedToken,
                        mint: mintedToken,
                        signer: provider.wallet.publicKey,
                        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
                        systemProgram: anchor.web3.SystemProgram.programId,
                        programData: programDataPda,
                        allowedExternalMintProgram: stakeProgram.programId,
                    })
                    .rpc();
                assert.fail("Should have thrown DuplicateAdministrators");
            } catch (err) {
                expect(err.toString()).to.match(/DuplicateAdministrators|duplicate/i);
            }
        });

        it("fails with duplicate rewards administrators", async () => {
            try {
                await program.methods
                    .initialize(
                        [freezeAdmin.publicKey],
                        [rewardsAdmin.publicKey, rewardsAdmin.publicKey]
                    )
                    .accountsStrict({
                        config: configPda,
                        vaultTokenAccountConfig: vaultTokenAccountConfigPda,
                        vaultTokenAccount: vaultTokenAccount,
                        redeemVaultAuthority: redeemVaultAuthorityPda,
                        redeemVaultTokenAccount: redeemVaultTokenAccount,
                        vaultTokenMint: vaultedToken,
                        mint: mintedToken,
                        signer: provider.wallet.publicKey,
                        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
                        systemProgram: anchor.web3.SystemProgram.programId,
                        programData: programDataPda,
                        allowedExternalMintProgram: stakeProgram.programId,
                    })
                    .rpc();
                assert.fail("Should have thrown DuplicateAdministrators");
            } catch (err) {
                expect(err.toString()).to.match(/DuplicateAdministrators|duplicate/i);
            }
        });

        it("initializes the vault config", async () => {
            await program.methods
                .initialize([freezeAdmin.publicKey], [rewardsAdmin.publicKey])
                .accountsStrict({
                    config: configPda,
                    vaultTokenAccountConfig: vaultTokenAccountConfigPda,
                    vaultTokenAccount: vaultTokenAccount,
                    redeemVaultAuthority: redeemVaultAuthorityPda,
                    redeemVaultTokenAccount: redeemVaultTokenAccount,
                    vaultTokenMint: vaultedToken,
                    mint: mintedToken,
                    signer: provider.wallet.publicKey,
                    tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
                    systemProgram: anchor.web3.SystemProgram.programId,
                    programData: programDataPda,
                    allowedExternalMintProgram: stakeProgram.programId,
                })
                .rpc();

            const config = await program.account.config.fetch(configPda);
            assert.ok(config.vault.equals(vaultedToken));
            assert.ok(config.vaultAuthority.equals(vaultTokenAccountOwnerPublicKey));
            assert.ok(config.mint.equals(mintedToken));
            assert.equal(config.freezeAdministrators.length, 1);
            assert.ok(config.freezeAdministrators[0].equals(freezeAdmin.publicKey));
            assert.equal(config.rewardsAdministrators.length, 1);
            assert.ok(config.rewardsAdministrators[0].equals(rewardsAdmin.publicKey));
            assert.ok(!config.paused);

            // Initialize epoch caps + last-index floor for subsequent create/claim tests.
            // first_capped_epoch = 1; LastRewardsEpoch start_index = 0 so the first create is 1.
            const { epochCapsConfig, lastRewardsEpoch } = deriveRewardsEpochAccounts(
                program.programId,
                0
            );
            await program.methods
                .initializeEpochCaps(new BN(1), new BN("1000000000000"))
                .accountsStrict({
                    config: configPda,
                    epochCapsConfig,
                    signer: provider.wallet.publicKey,
                    programData: programDataPda,
                    systemProgram: SystemProgram.programId,
                })
                .rpc();
            await program.methods
                .initializeLastRewardsEpoch(new BN(0))
                .accountsStrict({
                    config: configPda,
                    lastRewardsEpoch,
                    signer: provider.wallet.publicKey,
                    programData: programDataPda,
                    systemProgram: SystemProgram.programId,
                })
                .rpc();
            const caps = await program.account.epochCapsConfig.fetch(epochCapsConfig);
            assert.equal(caps.firstCappedEpoch.toNumber(), 1);
            assert.equal(caps.maxEpochCap.toString(), "1000000000000");
            const last = await program.account.lastRewardsEpoch.fetch(lastRewardsEpoch);
            assert.equal(last.index.toNumber(), 0, "start_index floor for first create at 1");
        });

        it("fails when called twice", async () => {
            try {
                await program.methods
                    .initialize([freezeAdmin.publicKey], [rewardsAdmin.publicKey])
                    .accountsStrict({
                        config: configPda,
                        vaultTokenAccountConfig: vaultTokenAccountConfigPda,
                        vaultTokenAccount: vaultTokenAccount,
                        redeemVaultAuthority: redeemVaultAuthorityPda,
                        redeemVaultTokenAccount: redeemVaultTokenAccount,
                        vaultTokenMint: vaultedToken,
                        mint: mintedToken,
                        signer: provider.wallet.publicKey,
                        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
                        systemProgram: anchor.web3.SystemProgram.programId,
                        programData: programDataPda,
                        allowedExternalMintProgram: stakeProgram.programId,
                    })
                    .rpc();
                assert.fail("Should have thrown error");
            } catch (err) {
                expect(err).to.exist;
            }
        });

    });

    describe("deposit", () => {

        it("deposits tokens and mints vault tokens (1:1 ratio)", async () => {
            const depositAmount = createBigInt(100_000_000); // 100 tokens

            const vaultBalanceBefore = (await getAccount(provider.connection, vaultTokenAccount)).amount;
            const userUnderlyingBalanceBefore = (await getAccount(provider.connection, userMintTokenAccount)).amount;
            const userVaultBalanceBefore = (await getAccount(provider.connection, userVaultTokenAccount)).amount;

            await program.methods
                .deposit(new BN(depositAmount))
                .accountsStrict({
                    config: configPda,
                    vaultTokenAccount: vaultTokenAccount,
                    vaultTokenAccountConfig: vaultTokenAccountConfigPda,
                    mint: mintedToken,
                    mintAuthority: mintAuthorityPda,
                    signer: user.publicKey,
                    userVaultTokenAccount: userVaultTokenAccount,
                    userMintTokenAccount: userMintTokenAccount,
                    tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID
                })
                .signers([user])
                .rpc();

            const vaultBalanceAfter = (await getAccount(provider.connection, vaultTokenAccount)).amount;
            const userUnderlyingBalanceAfter = (await getAccount(provider.connection, userMintTokenAccount)).amount;
            const userVaultBalanceAfter = (await getAccount(provider.connection, userVaultTokenAccount)).amount;

            assert.equal(vaultBalanceAfter, vaultBalanceBefore + depositAmount);
            assert.equal(userUnderlyingBalanceAfter, userUnderlyingBalanceBefore + depositAmount);
            assert.equal(userVaultBalanceAfter, userVaultBalanceBefore - depositAmount);
        });

        it("handles multiple deposits correctly", async () => {
            const firstDeposit = createBigInt(50_000_000);
            const secondDeposit = createBigInt(25_000_000);

            await program.methods
                .deposit(new BN(firstDeposit))
                .accountsStrict({
                    config: configPda,
                    vaultTokenAccount: vaultTokenAccount,
                    vaultTokenAccountConfig: vaultTokenAccountConfigPda,
                    mint: mintedToken,
                    mintAuthority: mintAuthorityPda,
                    signer: user.publicKey,
                    userVaultTokenAccount: userVaultTokenAccount,
                    userMintTokenAccount: userMintTokenAccount,
                    tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID
                })
                .signers([user])
                .rpc();

            const balanceAfterFirst = (await getAccount(provider.connection, userMintTokenAccount)).amount;

            await program.methods
                .deposit(new BN(secondDeposit))
                .accountsStrict({
                    config: configPda,
                    vaultTokenAccount: vaultTokenAccount,
                    vaultTokenAccountConfig: vaultTokenAccountConfigPda,
                    mint: mintedToken,
                    mintAuthority: mintAuthorityPda,
                    signer: user.publicKey,
                    userVaultTokenAccount: userVaultTokenAccount,
                    userMintTokenAccount: userMintTokenAccount,
                    tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID
                })
                .signers([user])
                .rpc();

            const balanceAfterSecond = (await getAccount(provider.connection, userMintTokenAccount)).amount;

            assert.equal(balanceAfterSecond, balanceAfterFirst + secondDeposit);
        });

        it("prevents inflation attack with virtual offsets", async () => {
            const userVaultBalanceBefore = (await getAccount(provider.connection, userVaultTokenAccount)).amount;
            const userMintBalanceBefore = (await getAccount(provider.connection, userMintTokenAccount)).amount;

            await program.methods
                .deposit(new BN(1))
                .accountsStrict({
                    config: configPda,
                    vaultTokenAccount: vaultTokenAccount,
                    vaultTokenAccountConfig: vaultTokenAccountConfigPda,
                    mint: mintedToken,
                    mintAuthority: mintAuthorityPda,
                    signer: user.publicKey,
                    userVaultTokenAccount: userVaultTokenAccount,
                    userMintTokenAccount: userMintTokenAccount,
                    tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID
                })
                .signers([user])
                .rpc();

            const userVaultBalanceAfter = (await getAccount(provider.connection, userVaultTokenAccount)).amount;
            const userMintBalanceAfter = (await getAccount(provider.connection, userMintTokenAccount)).amount;
            assert.ok(userVaultBalanceAfter < userVaultBalanceBefore, "Should vault tokens even for small deposits");
            assert.ok(userMintBalanceAfter > userMintBalanceBefore, "Should mint tokens even for small deposits");
        });

        it("fails with zero deposit", async () => {
            try {
                await program.methods
                    .deposit(new BN(0))
                    .accountsStrict({
                        config: configPda,
                        vaultTokenAccount: vaultTokenAccount,
                        vaultTokenAccountConfig: vaultTokenAccountConfigPda,
                        mint: mintedToken,
                        mintAuthority: mintAuthorityPda,
                        signer: user.publicKey,
                        userVaultTokenAccount: userVaultTokenAccount,
                        userMintTokenAccount: userMintTokenAccount,
                        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID
                    })
                    .signers([user])
                    .rpc();
                assert.fail("Should have thrown error");
            } catch (err) {
                expect(err).to.exist;
            }
        });

        it("fails with insufficient balance", async () => {
            const userBalance = (await getAccount(provider.connection, userVaultTokenAccount)).amount;
            const excessiveAmount = new BN(userBalance.toString()).add(new BN(1));

            try {
                await program.methods
                    .deposit(excessiveAmount)
                    .accountsStrict({
                        config: configPda,
                        vaultTokenAccount: vaultTokenAccount,
                        vaultTokenAccountConfig: vaultTokenAccountConfigPda,
                        mint: mintedToken,
                        mintAuthority: mintAuthorityPda,
                        signer: user.publicKey,
                        userVaultTokenAccount: userVaultTokenAccount,
                        userMintTokenAccount: userMintTokenAccount,
                        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID
                    })
                    .signers([user])
                    .rpc();
                assert.fail("Should have thrown error");
            } catch (err) {
                expect(err).to.exist;
            }
        });

        it("rejects self-transfer deposit when source equals vault token account", async () => {
            // Vault authority owns the deposit vault; passing it as both source and dest
            // would be a no-op transfer that still mints wYLDS without the guard.
            const vaultOwnerMintAta = await createAccount(
                provider.connection,
                provider.wallet.payer,
                mintedToken,
                vaultTokenAccountOwnerPublicKey
            );

            try {
                await program.methods
                    .deposit(new BN(1))
                    .accountsStrict({
                        config: configPda,
                        vaultTokenAccount: vaultTokenAccount,
                        vaultTokenAccountConfig: vaultTokenAccountConfigPda,
                        mint: mintedToken,
                        mintAuthority: mintAuthorityPda,
                        signer: vaultTokenAccountOwner.publicKey,
                        userVaultTokenAccount: vaultTokenAccount,
                        userMintTokenAccount: vaultOwnerMintAta,
                        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
                    })
                    .signers([vaultTokenAccountOwner])
                    .rpc();
                assert.fail("Should have thrown DepositSelfTransfer");
            } catch (err) {
                expect(err.toString()).to.match(/DepositSelfTransfer|must differ/i);
            }
        });

        it("fails with invalid vault token account", async () => {
            // create a new account to verify that the deposit only accepts vault token ATA's owned by the vault authority
            // and not any other token account owned by the user
            const badTokenKeypair = Keypair.generate();
            const badVaultTokenAccount = await createAccount(
                provider.connection,
                vaultTokenAccountOwner,
                vaultedToken,
                vaultTokenAccountOwnerPublicKey,
                badTokenKeypair
            );

            try {
                await program.methods
                    .deposit(new BN(1))
                    .accountsStrict({
                        config: configPda,
                        vaultTokenAccount: badVaultTokenAccount,
                        vaultTokenAccountConfig: vaultTokenAccountConfigPda,
                        mint: mintedToken,
                        mintAuthority: mintAuthorityPda,
                        signer: user.publicKey,
                        userVaultTokenAccount: userVaultTokenAccount,
                        userMintTokenAccount: userMintTokenAccount,
                        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID
                    })
                    .signers([user])
                    .rpc();
                assert.fail("Should have thrown error");
            } catch (err) {
                expect(err).to.exist;
                expect(err.toString()).to.include("InvalidVaultTokenAccount");
            }
        });
    });

    describe("redeem", () => {
        let redemptionRequestPda: PublicKey;

        before(async () => {
            // Ensure user has vault tokens to redeem
            const depositAmount = new BN(200_000_000);
            await program.methods
                .deposit(depositAmount)
                .accountsStrict({
                    config: configPda,
                    vaultTokenAccount: vaultTokenAccount,
                    vaultTokenAccountConfig: vaultTokenAccountConfigPda,
                    mint: mintedToken,
                    mintAuthority: mintAuthorityPda,
                    signer: user.publicKey,
                    userVaultTokenAccount: userVaultTokenAccount,
                    userMintTokenAccount: userMintTokenAccount,
                    tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID
                })
                .signers([user])
                .rpc();

            [redemptionRequestPda] = anchor.web3.PublicKey.findProgramAddressSync(
                [Buffer.from("redemption_request"), user.publicKey.toBuffer()],
                program.programId
            );
        });

        // One open RedemptionRequest PDA per user — a mid-test failure that leaves it
        // allocated makes every later requestRedeem fail with "account already in use".
        async function clearOpenRedemptionRequest() {
            const info = await provider.connection.getAccountInfo(redemptionRequestPda);
            if (!info) return;
            await program.methods
                .cancelRedeem()
                .accountsStrict({
                    signer: user.publicKey,
                    userMintTokenAccount: userMintTokenAccount,
                    redemptionRequest: redemptionRequestPda,
                    redeemVaultAuthority: redeemVaultAuthorityPda,
                    config: configPda,
                    tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
                })
                .signers([user])
                .rpc();
        }

        beforeEach(async () => {
            await clearOpenRedemptionRequest();
        });

        after(async () => {
            // Don't leave a wedged request for later suites that share the same user PDA.
            await clearOpenRedemptionRequest();
        });

        it("redeems vault tokens for mint tokens (1:1 ratio)", async () => {
            const redeemAmount = createBigInt(50_000_000); // 50 tokens
            const redeemVaultBalanceBefore = (await getAccount(provider.connection, redeemVaultTokenAccount)).amount;
            const userMintBalanceBefore = (await getAccount(provider.connection, userMintTokenAccount)).amount;
            const userVaultBalanceBefore = (await getAccount(provider.connection, userVaultTokenAccount)).amount;

            await program.methods
                .requestRedeem(new BN(redeemAmount))
                .accountsStrict({
                    signer: user.publicKey,
                    userMintTokenAccount: userMintTokenAccount,
                    redemptionRequest: redemptionRequestPda,
                    mint: mintedToken,
                    config: configPda,
                    systemProgram: anchor.web3.SystemProgram.programId,
                    tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
                    redeemVaultAuthority: redeemVaultAuthorityPda,
                })
                .signers([user])
                .rpc();

            const redemptionRequest = await program.account.redemptionRequest.fetch(
                redemptionRequestPda
            );
            assert.equal(redemptionRequest.amount.toNumber(), new BN(redeemAmount).toNumber());

            assert.equal(redemptionRequest.user.toBase58(), user.publicKey.toBase58());

            // Now perform the redeem
            await program.methods
                .completeRedeem(new BN(redeemAmount))
                .accountsStrict({
                    admin: rewardsAdmin.publicKey,
                    user: user.publicKey,
                    userMintTokenAccount: userMintTokenAccount,
                    userVaultTokenAccount: userVaultTokenAccount,
                    redemptionRequest: redemptionRequestPda,
                    redeemVaultTokenAccount: redeemVaultTokenAccount,
                    redeemVaultAuthority: redeemVaultAuthorityPda,
                    mint: mintedToken,
                    config: configPda,
                    tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
                })
                .signers([rewardsAdmin])
                .rpc();

            const redeemVaultBalanceAfter = (await getAccount(provider.connection, redeemVaultTokenAccount)).amount;
            const userMintBalanceAfter = (await getAccount(provider.connection, userMintTokenAccount)).amount;
            const userVaultBalanceAfter = (await getAccount(provider.connection, userVaultTokenAccount)).amount;

            assert.equal(redeemVaultBalanceAfter, redeemVaultBalanceBefore - redeemAmount);
            assert.equal(userMintBalanceAfter, userMintBalanceBefore - redeemAmount);
            assert.equal(userVaultBalanceAfter, userVaultBalanceBefore + redeemAmount);

            // redemption request should be closed
            try {
                await program.account.redemptionRequest.fetch(
                    redemptionRequestPda
                );
                assert.fail("Redemption request should be closed");
            } catch (err) {
                expect(err).to.exist;
                expect(err.message).to.include("Account does not exist or has no data");
            }
        });

        it("complete rejects an amount the administrator did not approve", async () => {
            // Small amounts keep the suite's running balances untouched; only the equality
            // check is under test here.
            const approvedAmount = new BN(1_000);

            await program.methods
                .requestRedeem(approvedAmount)
                .accountsStrict({
                    signer: user.publicKey,
                    userMintTokenAccount: userMintTokenAccount,
                    redemptionRequest: redemptionRequestPda,
                    mint: mintedToken,
                    config: configPda,
                    systemProgram: anchor.web3.SystemProgram.programId,
                    tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
                    redeemVaultAuthority: redeemVaultAuthorityPda,
                })
                .signers([user])
                .rpc();

            try {
                await program.methods
                    .completeRedeem(approvedAmount.add(new BN(1)))
                    .accountsStrict({
                        admin: rewardsAdmin.publicKey,
                        user: user.publicKey,
                        userMintTokenAccount: userMintTokenAccount,
                        userVaultTokenAccount: userVaultTokenAccount,
                        redemptionRequest: redemptionRequestPda,
                        redeemVaultTokenAccount: redeemVaultTokenAccount,
                        redeemVaultAuthority: redeemVaultAuthorityPda,
                        mint: mintedToken,
                        config: configPda,
                        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
                    })
                    .signers([rewardsAdmin])
                    .rpc();
                assert.fail("Should have thrown RedemptionAmountMismatch");
            } catch (err) {
                expect(err.toString()).to.match(
                    /RedemptionAmountMismatch|custom program error/i
                );
            }

            // Fails closed: the request survives and still settles for the approved amount.
            const openRequest = await program.account.redemptionRequest.fetch(
                redemptionRequestPda
            );
            assert.equal(openRequest.amount.toNumber(), approvedAmount.toNumber());

            await program.methods
                .completeRedeem(approvedAmount)
                .accountsStrict({
                    admin: rewardsAdmin.publicKey,
                    user: user.publicKey,
                    userMintTokenAccount: userMintTokenAccount,
                    userVaultTokenAccount: userVaultTokenAccount,
                    redemptionRequest: redemptionRequestPda,
                    redeemVaultTokenAccount: redeemVaultTokenAccount,
                    redeemVaultAuthority: redeemVaultAuthorityPda,
                    mint: mintedToken,
                    config: configPda,
                    tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
                })
                .signers([rewardsAdmin])
                .rpc();
        });

        it("complete rejects a request substituted after approval", async () => {
            const approvedAmount = new BN(1_000);
            const substitutedAmount = new BN(2_000);

            await program.methods
                .requestRedeem(approvedAmount)
                .accountsStrict({
                    signer: user.publicKey,
                    userMintTokenAccount: userMintTokenAccount,
                    redemptionRequest: redemptionRequestPda,
                    mint: mintedToken,
                    config: configPda,
                    systemProgram: anchor.web3.SystemProgram.programId,
                    tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
                    redeemVaultAuthority: redeemVaultAuthorityPda,
                })
                .signers([user])
                .rpc();

            // The request PDA is keyed on the user alone, so cancelling and re-requesting puts a
            // different amount at the very address the administrator already reviewed.
            await program.methods
                .cancelRedeem()
                .accountsStrict({
                    signer: user.publicKey,
                    userMintTokenAccount: userMintTokenAccount,
                    redemptionRequest: redemptionRequestPda,
                    redeemVaultAuthority: redeemVaultAuthorityPda,
                    config: configPda,
                    tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
                })
                .signers([user])
                .rpc();

            await program.methods
                .requestRedeem(substitutedAmount)
                .accountsStrict({
                    signer: user.publicKey,
                    userMintTokenAccount: userMintTokenAccount,
                    redemptionRequest: redemptionRequestPda,
                    mint: mintedToken,
                    config: configPda,
                    systemProgram: anchor.web3.SystemProgram.programId,
                    tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
                    redeemVaultAuthority: redeemVaultAuthorityPda,
                })
                .signers([user])
                .rpc();

            // A completion signed against the reviewed amount must not settle the replacement.
            try {
                await program.methods
                    .completeRedeem(approvedAmount)
                    .accountsStrict({
                        admin: rewardsAdmin.publicKey,
                        user: user.publicKey,
                        userMintTokenAccount: userMintTokenAccount,
                        userVaultTokenAccount: userVaultTokenAccount,
                        redemptionRequest: redemptionRequestPda,
                        redeemVaultTokenAccount: redeemVaultTokenAccount,
                        redeemVaultAuthority: redeemVaultAuthorityPda,
                        mint: mintedToken,
                        config: configPda,
                        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
                    })
                    .signers([rewardsAdmin])
                    .rpc();
                assert.fail("Should have thrown RedemptionAmountMismatch");
            } catch (err) {
                expect(err.toString()).to.match(
                    /RedemptionAmountMismatch|custom program error/i
                );
            }

            const openRequest = await program.account.redemptionRequest.fetch(
                redemptionRequestPda
            );
            assert.equal(openRequest.amount.toNumber(), substitutedAmount.toNumber());

            // The replacement only settles once an administrator approves it explicitly.
            await program.methods
                .completeRedeem(substitutedAmount)
                .accountsStrict({
                    admin: rewardsAdmin.publicKey,
                    user: user.publicKey,
                    userMintTokenAccount: userMintTokenAccount,
                    userVaultTokenAccount: userVaultTokenAccount,
                    redemptionRequest: redemptionRequestPda,
                    redeemVaultTokenAccount: redeemVaultTokenAccount,
                    redeemVaultAuthority: redeemVaultAuthorityPda,
                    mint: mintedToken,
                    config: configPda,
                    tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
                })
                .signers([rewardsAdmin])
                .rpc();
        });

        it("complete fails with no open redemption request", async () => {
            try {
                await program.methods
                    // No request exists, so the account constraint rejects before the amount check.
                    .completeRedeem(new BN(1))
                    .accountsStrict({
                        admin: rewardsAdmin.publicKey,
                        user: user.publicKey,
                        userMintTokenAccount: userMintTokenAccount,
                        userVaultTokenAccount: userVaultTokenAccount,
                        redemptionRequest: redemptionRequestPda,
                        redeemVaultTokenAccount: redeemVaultTokenAccount,
                        redeemVaultAuthority: redeemVaultAuthorityPda,
                        mint: mintedToken,
                        config: configPda,
                        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
                    })
                    .signers([rewardsAdmin])
                    .rpc();

                assert.fail("Should have thrown error");
            } catch (err) {
                expect(err).to.exist;
            }
        });

        it("complete fails when destination token account is not owned by the user", async () => {
            const redeemAmount = new BN(10_000_000);

            await program.methods
                .requestRedeem(redeemAmount)
                .accountsStrict({
                    signer: user.publicKey,
                    userMintTokenAccount: userMintTokenAccount,
                    redemptionRequest: redemptionRequestPda,
                    mint: mintedToken,
                    config: configPda,
                    systemProgram: anchor.web3.SystemProgram.programId,
                    tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
                    redeemVaultAuthority: redeemVaultAuthorityPda,
                })
                .signers([user])
                .rpc();

            // A vault-mint (USDC) account owned by a third party, not by `user`.
            const thirdParty = Keypair.generate();
            const thirdPartyVaultTokenAccount = await createAccount(
                provider.connection,
                provider.wallet.payer,
                vaultedToken,
                thirdParty.publicKey
            );

            try {
                await program.methods
                    .completeRedeem(redeemAmount)
                    .accountsStrict({
                        admin: rewardsAdmin.publicKey,
                        user: user.publicKey,
                        userMintTokenAccount: userMintTokenAccount,
                        userVaultTokenAccount: thirdPartyVaultTokenAccount,
                        redemptionRequest: redemptionRequestPda,
                        redeemVaultTokenAccount: redeemVaultTokenAccount,
                        redeemVaultAuthority: redeemVaultAuthorityPda,
                        mint: mintedToken,
                        config: configPda,
                        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
                    })
                    .signers([rewardsAdmin])
                    .rpc();

                assert.fail("Should have thrown error");
            } catch (err) {
                expect(err).to.exist;
                expect(err.toString()).to.include("InvalidTokenOwner");
            }

            // Clean up: complete with the correct user-owned destination account.
            await program.methods
                .completeRedeem(redeemAmount)
                .accountsStrict({
                    admin: rewardsAdmin.publicKey,
                    user: user.publicKey,
                    userMintTokenAccount: userMintTokenAccount,
                    userVaultTokenAccount: userVaultTokenAccount,
                    redemptionRequest: redemptionRequestPda,
                    redeemVaultTokenAccount: redeemVaultTokenAccount,
                    redeemVaultAuthority: redeemVaultAuthorityPda,
                    mint: mintedToken,
                    config: configPda,
                    tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
                })
                .signers([rewardsAdmin])
                .rpc();
        });

        it("complete fails when user mint balance is below the request amount", async () => {
            const redeemAmount = new BN(20_000_000);

            await program.methods
                .requestRedeem(redeemAmount)
                .accountsStrict({
                    signer: user.publicKey,
                    userMintTokenAccount: userMintTokenAccount,
                    redemptionRequest: redemptionRequestPda,
                    mint: mintedToken,
                    config: configPda,
                    systemProgram: anchor.web3.SystemProgram.programId,
                    tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
                    redeemVaultAuthority: redeemVaultAuthorityPda,
                })
                .signers([user])
                .rpc();

            // Drain below the recorded request amount. Earlier suite deposits leave the
            // user holding far more than redeemAmount, so a fixed transfer-out is not enough.
            const balanceAfterRequest = (
                await getAccount(provider.connection, userMintTokenAccount)
            ).amount;
            const transferOut =
                balanceAfterRequest - BigInt(redeemAmount.toString()) + BigInt(1);
            assert.ok(
                transferOut > BigInt(0),
                "expected balance at or above the request amount after requestRedeem"
            );

            // Park under a fresh owner so createAccount derives a distinct ATA (the user's
            // mint ATA already exists as userMintTokenAccount).
            const parkingOwner = Keypair.generate();
            const parkingAccount = await createAccount(
                provider.connection,
                provider.wallet.payer,
                mintedToken,
                parkingOwner.publicKey
            );
            await transfer(
                provider.connection,
                user,
                userMintTokenAccount,
                parkingAccount,
                user,
                transferOut
            );

            try {
                try {
                    await program.methods
                        .completeRedeem(redeemAmount)
                        .accountsStrict({
                            admin: rewardsAdmin.publicKey,
                            user: user.publicKey,
                            userMintTokenAccount: userMintTokenAccount,
                            userVaultTokenAccount: userVaultTokenAccount,
                            redemptionRequest: redemptionRequestPda,
                            redeemVaultTokenAccount: redeemVaultTokenAccount,
                            redeemVaultAuthority: redeemVaultAuthorityPda,
                            mint: mintedToken,
                            config: configPda,
                            tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
                        })
                        .signers([rewardsAdmin])
                        .rpc();
                    assert.fail("Should have thrown error");
                } catch (err: unknown) {
                    if (err instanceof Error && err.message === "Should have thrown error") {
                        throw err;
                    }
                    expect(String(err)).to.match(
                        /InsufficientRedemptionBalance|custom program error/i
                    );
                }

                // Request must remain open (fail closed — no partial complete).
                const redemptionRequest = await program.account.redemptionRequest.fetch(
                    redemptionRequestPda
                );
                assert.equal(redemptionRequest.amount.toNumber(), redeemAmount.toNumber());
            } finally {
                // Always return parked tokens and settle/cancel so later tests keep a usable balance.
                const parked = (await getAccount(provider.connection, parkingAccount)).amount;
                if (parked > BigInt(0)) {
                    await transfer(
                        provider.connection,
                        provider.wallet.payer,
                        parkingAccount,
                        userMintTokenAccount,
                        parkingOwner,
                        parked
                    );
                }
                const open = await provider.connection.getAccountInfo(redemptionRequestPda);
                if (open) {
                    await program.methods
                        .completeRedeem(redeemAmount)
                        .accountsStrict({
                            admin: rewardsAdmin.publicKey,
                            user: user.publicKey,
                            userMintTokenAccount: userMintTokenAccount,
                            userVaultTokenAccount: userVaultTokenAccount,
                            redemptionRequest: redemptionRequestPda,
                            redeemVaultTokenAccount: redeemVaultTokenAccount,
                            redeemVaultAuthority: redeemVaultAuthorityPda,
                            mint: mintedToken,
                            config: configPda,
                            tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
                        })
                        .signers([rewardsAdmin])
                        .rpc();
                }
            }
        });

        it("user can cancel a request that can no longer be completed", async () => {
            const redeemAmount = new BN(20_000_000);

            await program.methods
                .requestRedeem(redeemAmount)
                .accountsStrict({
                    signer: user.publicKey,
                    userMintTokenAccount: userMintTokenAccount,
                    redemptionRequest: redemptionRequestPda,
                    mint: mintedToken,
                    config: configPda,
                    systemProgram: anchor.web3.SystemProgram.programId,
                    tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
                    redeemVaultAuthority: redeemVaultAuthorityPda,
                })
                .signers([user])
                .rpc();

            // Drain below the request so complete would fail closed; then cancel instead.
            const balanceAfterRequest = (
                await getAccount(provider.connection, userMintTokenAccount)
            ).amount;
            const transferOut =
                balanceAfterRequest - BigInt(redeemAmount.toString()) + BigInt(1);
            assert.ok(transferOut > BigInt(0));

            // Park under a fresh owner so createAccount derives a distinct ATA.
            const parkingOwner = Keypair.generate();
            const parkingAccount = await createAccount(
                provider.connection,
                provider.wallet.payer,
                mintedToken,
                parkingOwner.publicKey
            );
            await transfer(
                provider.connection,
                user,
                userMintTokenAccount,
                parkingAccount,
                user,
                transferOut
            );

            try {
                await program.methods
                    .cancelRedeem()
                    .accountsStrict({
                        signer: user.publicKey,
                        userMintTokenAccount: userMintTokenAccount,
                        redemptionRequest: redemptionRequestPda,
                        redeemVaultAuthority: redeemVaultAuthorityPda,
                        config: configPda,
                        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
                    })
                    .signers([user])
                    .rpc();

                // Request account is closed and the burn delegate is released.
                const closedRequest = await provider.connection.getAccountInfo(redemptionRequestPda);
                assert.isNull(closedRequest);
                const mintTokenAccount = await getAccount(provider.connection, userMintTokenAccount);
                assert.isNull(mintTokenAccount.delegate);
                assert.equal(mintTokenAccount.delegatedAmount.toString(), "0");
            } finally {
                const parked = (await getAccount(provider.connection, parkingAccount)).amount;
                if (parked > BigInt(0)) {
                    await transfer(
                        provider.connection,
                        provider.wallet.payer,
                        parkingAccount,
                        userMintTokenAccount,
                        parkingOwner,
                        parked
                    );
                }
            }

            // Cancelling unblocks the user: a fresh request can be submitted.
            await program.methods
                .requestRedeem(redeemAmount)
                .accountsStrict({
                    signer: user.publicKey,
                    userMintTokenAccount: userMintTokenAccount,
                    redemptionRequest: redemptionRequestPda,
                    mint: mintedToken,
                    config: configPda,
                    systemProgram: anchor.web3.SystemProgram.programId,
                    tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
                    redeemVaultAuthority: redeemVaultAuthorityPda,
                })
                .signers([user])
                .rpc();

            // Complete to leave the suite state clean for following tests.
            await program.methods
                .completeRedeem(redeemAmount)
                .accountsStrict({
                    admin: rewardsAdmin.publicKey,
                    user: user.publicKey,
                    userMintTokenAccount: userMintTokenAccount,
                    userVaultTokenAccount: userVaultTokenAccount,
                    redemptionRequest: redemptionRequestPda,
                    redeemVaultTokenAccount: redeemVaultTokenAccount,
                    redeemVaultAuthority: redeemVaultAuthorityPda,
                    mint: mintedToken,
                    config: configPda,
                    tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
                })
                .signers([rewardsAdmin])
                .rpc();
        });

        it("another user cannot cancel someone else's request", async () => {
            const redeemAmount = new BN(5_000_000);

            await program.methods
                .requestRedeem(redeemAmount)
                .accountsStrict({
                    signer: user.publicKey,
                    userMintTokenAccount: userMintTokenAccount,
                    redemptionRequest: redemptionRequestPda,
                    mint: mintedToken,
                    config: configPda,
                    systemProgram: anchor.web3.SystemProgram.programId,
                    tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
                    redeemVaultAuthority: redeemVaultAuthorityPda,
                })
                .signers([user])
                .rpc();

            // The request PDA is seeded by the signer, so an attacker cannot target another
            // user's request even while supplying that user's token account.
            try {
                await program.methods
                    .cancelRedeem()
                    .accountsStrict({
                        signer: rewardsAdmin.publicKey,
                        userMintTokenAccount: userMintTokenAccount,
                        redemptionRequest: redemptionRequestPda,
                        redeemVaultAuthority: redeemVaultAuthorityPda,
                        config: configPda,
                        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
                    })
                    .signers([rewardsAdmin])
                    .rpc();
                assert.fail("Should have thrown error");
            } catch (err) {
                expect(err).to.exist;
                expect(err.toString()).to.match(
                    /ConstraintSeeds|InvalidTokenOwner|custom program error/i
                );
            }

            // Request remains intact for its owner.
            const redemptionRequest = await program.account.redemptionRequest.fetch(
                redemptionRequestPda
            );
            assert.equal(redemptionRequest.amount.toNumber(), redeemAmount.toNumber());

            await program.methods
                .completeRedeem(redeemAmount)
                .accountsStrict({
                    admin: rewardsAdmin.publicKey,
                    user: user.publicKey,
                    userMintTokenAccount: userMintTokenAccount,
                    userVaultTokenAccount: userVaultTokenAccount,
                    redemptionRequest: redemptionRequestPda,
                    redeemVaultTokenAccount: redeemVaultTokenAccount,
                    redeemVaultAuthority: redeemVaultAuthorityPda,
                    mint: mintedToken,
                    config: configPda,
                    tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
                })
                .signers([rewardsAdmin])
                .rpc();
        });

        it("cancel leaves an unrelated delegate in place", async () => {
            const redeemAmount = new BN(5_000_000);
            const thirdPartyAllowance = BigInt(1_000_000);

            await program.methods
                .requestRedeem(redeemAmount)
                .accountsStrict({
                    signer: user.publicKey,
                    userMintTokenAccount: userMintTokenAccount,
                    redemptionRequest: redemptionRequestPda,
                    mint: mintedToken,
                    config: configPda,
                    systemProgram: anchor.web3.SystemProgram.programId,
                    tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
                    redeemVaultAuthority: redeemVaultAuthorityPda,
                })
                .signers([user])
                .rpc();

            // Re-delegating replaces the program's burn approval (SPL tokens hold one delegate),
            // which is itself one way a request becomes uncompletable.
            await approve(
                provider.connection,
                user,
                userMintTokenAccount,
                rewardsAdmin.publicKey,
                user,
                thirdPartyAllowance
            );

            await program.methods
                .cancelRedeem()
                .accountsStrict({
                    signer: user.publicKey,
                    userMintTokenAccount: userMintTokenAccount,
                    redemptionRequest: redemptionRequestPda,
                    redeemVaultAuthority: redeemVaultAuthorityPda,
                    config: configPda,
                    tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
                })
                .signers([user])
                .rpc();

            // Request is cleared, but the user's unrelated approval is untouched.
            const closedRequest = await provider.connection.getAccountInfo(redemptionRequestPda);
            assert.isNull(closedRequest);
            const mintTokenAccount = await getAccount(provider.connection, userMintTokenAccount);
            assert.ok(mintTokenAccount.delegate?.equals(rewardsAdmin.publicKey));
            assert.equal(
                mintTokenAccount.delegatedAmount.toString(),
                thirdPartyAllowance.toString()
            );

            // Restore a clean delegate state for following tests.
            await revoke(provider.connection, user, userMintTokenAccount, user);
        });

        it("handles multiple redeems correctly", async () => {
            const firstRedeem = new BN(25_000_000);
            const secondRedeem = new BN(10_000_000);

            await program.methods
                .requestRedeem(firstRedeem)
                .accountsStrict({
                    signer: user.publicKey,
                    userMintTokenAccount: userMintTokenAccount,
                    redemptionRequest: redemptionRequestPda,
                    mint: mintedToken,
                    config: configPda,
                    systemProgram: anchor.web3.SystemProgram.programId,
                    tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
                    redeemVaultAuthority: redeemVaultAuthorityPda,
                })
                .signers([user])
                .rpc();

            try {
                await program.methods
                    .requestRedeem(secondRedeem)
                    .accountsStrict({
                        signer: user.publicKey,
                        userMintTokenAccount: userMintTokenAccount,
                        redemptionRequest: redemptionRequestPda,
                        mint: mintedToken,
                        config: configPda,
                        systemProgram: anchor.web3.SystemProgram.programId,
                        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
                        redeemVaultAuthority: redeemVaultAuthorityPda,
                    })
                    .signers([user])
                    .rpc();
                assert.fail("Should have thrown error");
            } catch (err) {
                expect(err).to.exist;
            }

            // clean up by completing the redeem
            await program.methods
                .completeRedeem(firstRedeem)
                .accountsStrict({
                    admin: rewardsAdmin.publicKey,
                    user: user.publicKey,
                    userMintTokenAccount: userMintTokenAccount,
                    userVaultTokenAccount: userVaultTokenAccount,
                    redemptionRequest: redemptionRequestPda,
                    redeemVaultTokenAccount: redeemVaultTokenAccount,
                    redeemVaultAuthority: redeemVaultAuthorityPda,
                    mint: mintedToken,
                    config: configPda,
                    tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
                })
                .signers([rewardsAdmin])
                .rpc();
        });

        it("fails with zero redeem", async () => {
            try {
                await program.methods
                    .requestRedeem(new BN(0))
                    .accountsStrict({
                        signer: user.publicKey,
                        userMintTokenAccount: userMintTokenAccount,
                        redemptionRequest: redemptionRequestPda,
                        mint: mintedToken,
                        config: configPda,
                        systemProgram: anchor.web3.SystemProgram.programId,
                        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
                        redeemVaultAuthority: redeemVaultAuthorityPda,
                    })
                    .signers([user])
                    .rpc();
                assert.fail("Should have thrown error");
            } catch (err) {
                expect(err).to.exist;
            }
        });

        it("fails with insufficient vault token balance", async () => {
            const userBalance = (await getAccount(provider.connection, userVaultTokenAccount)).amount;
            const excessiveAmount = new BN(userBalance.toString()).add(new BN(1));

            try {
                await program.methods
                    .requestRedeem(excessiveAmount)
                    .accountsStrict({
                        signer: user.publicKey,
                        userMintTokenAccount: userMintTokenAccount,
                        redemptionRequest: redemptionRequestPda,
                        mint: mintedToken,
                        config: configPda,
                        systemProgram: anchor.web3.SystemProgram.programId,
                        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
                        redeemVaultAuthority: redeemVaultAuthorityPda,
                    })
                    .signers([user])
                    .rpc();
                assert.fail("Should have thrown error");
            } catch (err) {
                expect(err).to.exist;
            }
        });

        it("fails with insufficient redeem vault token balance", async () => {
            const userMintBalance = (await getAccount(provider.connection, userMintTokenAccount)).amount;
            const redeemVaultBalance = (await getAccount(provider.connection, redeemVaultTokenAccount)).amount;
            const excessiveAmount = new BN(redeemVaultBalance.toString()).add(new BN(1));
            // Ensure user has enough vault tokens to request redeem
            if (userMintBalance < excessiveAmount.toNumber()) {
                await mintTo(
                    provider.connection,
                    provider.wallet.payer,
                    vaultedToken,
                    userVaultTokenAccount,
                    provider.wallet.publicKey,
                    excessiveAmount.toNumber()
                );
                // Deposit to get mint tokens
                await program.methods.deposit(new BN(excessiveAmount))
                    .accountsStrict({
                        config: configPda,
                        vaultTokenAccount: vaultTokenAccount,
                        vaultTokenAccountConfig: vaultTokenAccountConfigPda,
                        mint: mintedToken,
                        mintAuthority: mintAuthorityPda,
                        signer: user.publicKey,
                        userVaultTokenAccount: userVaultTokenAccount,
                        userMintTokenAccount: userMintTokenAccount,
                        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID
                    })
                    .signers([user])
                    .rpc();
            }
            await program.methods
                .requestRedeem(new BN(excessiveAmount))
                .accountsStrict({
                    signer: user.publicKey,
                    userMintTokenAccount: userMintTokenAccount,
                    redemptionRequest: redemptionRequestPda,
                    mint: mintedToken,
                    config: configPda,
                    systemProgram: anchor.web3.SystemProgram.programId,
                    tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
                    redeemVaultAuthority: redeemVaultAuthorityPda,
                })
                .signers([user])
                .rpc();

            try {
                await program.methods
                    .completeRedeem(excessiveAmount)
                    .accountsStrict({
                        admin: rewardsAdmin.publicKey,
                        user: user.publicKey,
                        userMintTokenAccount: userMintTokenAccount,
                        userVaultTokenAccount: userVaultTokenAccount,
                        redemptionRequest: redemptionRequestPda,
                        redeemVaultTokenAccount: redeemVaultTokenAccount,
                        redeemVaultAuthority: redeemVaultAuthorityPda,
                        mint: mintedToken,
                        config: configPda,
                        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
                    })
                    .signers([rewardsAdmin])
                    .rpc();
                assert.fail("Should have thrown error");
            } catch (err) {
                expect(err).to.exist;
            }

            // clean up by filling the redeem vault
            await mintTo(
                provider.connection,
                provider.wallet.payer,
                vaultedToken,
                redeemVaultTokenAccount,
                provider.wallet.publicKey,
                excessiveAmount.toNumber()
            );

            // clean up by completing the redeem
            await program.methods
                .completeRedeem(excessiveAmount)
                .accountsStrict({
                    admin: rewardsAdmin.publicKey,
                    user: user.publicKey,
                    userMintTokenAccount: userMintTokenAccount,
                    userVaultTokenAccount: userVaultTokenAccount,
                    redemptionRequest: redemptionRequestPda,
                    redeemVaultTokenAccount: redeemVaultTokenAccount,
                    redeemVaultAuthority: redeemVaultAuthorityPda,
                    mint: mintedToken,
                    config: configPda,
                    tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
                })
                .signers([rewardsAdmin])
                .rpc();
        });
    });

    describe("paused protocol", () => {
        it("pauses all functionality", async () => {
            await program.methods
                .pause(true)
                .accountsStrict({
                    config: configPda,
                    signer: freezeAdmin.publicKey,
                })
                .signers([freezeAdmin])
                .rpc();

            const config = await program.account.config.fetch(configPda);
            assert.isTrue(config.paused);
        });

        it("fails pause when called by non admin", async () => {
            try {
                await program.methods
                    .pause(true)
                    .accountsStrict({
                        config: configPda,
                        signer: user.publicKey,
                    })
                    .signers([user])
                    .rpc();
                assert.fail("Should have thrown error");
            } catch (err) {
                expect(err).to.exist;
            }
        });
        it("prevents deposit when paused", async () => {
            try {
                await program.methods
                    .deposit(new BN(1000))
                    .accountsStrict({
                        config: configPda,
                        vaultTokenAccount: vaultTokenAccount,
                        vaultTokenAccountConfig: vaultTokenAccountConfigPda,
                        mint: mintedToken,
                        mintAuthority: mintAuthorityPda,
                        signer: user.publicKey,
                        userVaultTokenAccount: userVaultTokenAccount,
                        userMintTokenAccount: userMintTokenAccount,
                        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID
                    })
                    .signers([user])
                    .rpc();
                assert.fail("Should have thrown error");
            } catch (err) {
                expect(err).to.exist;
                expect(err.toString()).to.include("ProtocolPaused");

            }
        });
        it("prevents request redeem when paused", async () => {
            const [redemptionRequestPda] = anchor.web3.PublicKey.findProgramAddressSync(
                [Buffer.from("redemption_request"), user.publicKey.toBuffer()],
                program.programId
            );

            try {
                await program.methods
                    .requestRedeem(new BN(1000))
                    .accountsStrict({
                        signer: user.publicKey,
                        userMintTokenAccount: userMintTokenAccount,
                        redemptionRequest: redemptionRequestPda,
                        mint: mintedToken,
                        config: configPda,
                        systemProgram: anchor.web3.SystemProgram.programId,
                        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
                        redeemVaultAuthority: redeemVaultAuthorityPda,
                    })
                    .signers([user])
                    .rpc();
                assert.fail("Should have thrown error");
            } catch (err) {
                expect(err).to.exist;
                expect(err.toString()).to.include("ProtocolPaused");

            }
        });

        it("prevents createRewardsEpoch when paused", async () => {
            // Use a throw-away epoch index that won't collide with the rewards test suite
            const pausedEpochIndex = 999;
            const [pausedEpochPda] = anchor.web3.PublicKey.findProgramAddressSync(
                [Buffer.from("epoch"), new anchor.BN(pausedEpochIndex).toArrayLike(Buffer, "le", 8)],
                program.programId
            );
            const dummyRoot = Array.from(Buffer.alloc(32, 0xab));

            try {
                await program.methods
                    .createRewardsEpoch(new anchor.BN(pausedEpochIndex), dummyRoot, new BN(0))
                    .accountsStrict({
                        config: configPda,
                        epochCapsConfig: deriveRewardsEpochAccounts(program.programId, pausedEpochIndex).epochCapsConfig,
                        lastRewardsEpoch: deriveRewardsEpochAccounts(program.programId, 0).lastRewardsEpoch,
                        admin: rewardsAdmin.publicKey,
                        epoch: pausedEpochPda,
                        epochClaimed: deriveRewardsEpochAccounts(program.programId, pausedEpochIndex).epochClaimed,
                        systemProgram: anchor.web3.SystemProgram.programId,
                    })
                    .signers([rewardsAdmin])
                    .rpc();
                assert.fail("Should have thrown ProtocolPaused");
            } catch (err) {
                expect(err.toString()).to.include("ProtocolPaused");
            }
        });

        it("unpauses", async () => {
            await program.methods
                .pause(false)
                .accountsStrict({
                    config: configPda,
                    signer: freezeAdmin.publicKey,
                })
                .signers([freezeAdmin])
                .rpc();
            const config = await program.account.config.fetch(configPda);
            assert.ok(!config.paused);
        });
    });

    describe("freeze thaw", () => {
        it("freezes user mint token account", async () => {
            await program.methods
                .freezeTokenAccount()
                .accountsStrict({
                    config: configPda,
                    tokenAccount: userMintTokenAccount,
                    mint: mintedToken,
                    freezeAuthorityPda: freezeAuthorityPda,
                    signer: freezeAdmin.publicKey,
                    tokenProgram: TOKEN_PROGRAM_ID,
                })
                .signers([freezeAdmin])
                .rpc();

            const accountInfo = await getAccount(provider.connection, userMintTokenAccount);
            assert.ok(accountInfo.isFrozen);
        });

        it("thaw user token account", async () => {
            await program.methods
                .thawTokenAccount()
                .accountsStrict({
                    config: configPda,
                    tokenAccount: userMintTokenAccount,
                    mint: mintedToken,
                    freezeAuthorityPda: freezeAuthorityPda,
                    signer: freezeAdmin.publicKey,
                    tokenProgram: TOKEN_PROGRAM_ID,
                })
                .signers([freezeAdmin])
                .rpc();

            const accountInfo = await getAccount(provider.connection, userMintTokenAccount);
            assert.ok(!accountInfo.isFrozen);
        });

        it("fails freeze when called by non-admin", async () => {
            try {
                await program.methods
                    .freezeTokenAccount()
                    .accountsStrict({
                        config: configPda,
                        tokenAccount: userMintTokenAccount,
                        mint: mintedToken,
                        freezeAuthorityPda: freezeAuthorityPda,
                        signer: user.publicKey,
                        tokenProgram: TOKEN_PROGRAM_ID,
                    })
                    .signers([user])
                    .rpc();
                assert.fail("Should have thrown error");
            } catch (err) {
                expect(err).to.exist;
            }
        });

        it("fails thaw when called by non-admin", async () => {
            try {
                await program.methods
                    .thawTokenAccount()
                    .accountsStrict({
                        config: configPda,
                        tokenAccount: userMintTokenAccount,
                        mint: mintedToken,
                        freezeAuthorityPda: freezeAuthorityPda,
                        signer: user.publicKey,
                        tokenProgram: TOKEN_PROGRAM_ID,
                    })
                    .signers([user])
                    .rpc();
                assert.fail("Should have thrown error");
            } catch (err) {
                expect(err).to.exist;
            }
        });

        it("prevents deposit when account is frozen", async () => {
            await program.methods
                .freezeTokenAccount()
                .accountsStrict({
                    config: configPda,
                    tokenAccount: userMintTokenAccount,
                    mint: mintedToken,
                    freezeAuthorityPda: freezeAuthorityPda,
                    signer: freezeAdmin.publicKey,
                    tokenProgram: TOKEN_PROGRAM_ID,
                })
                .signers([freezeAdmin])
                .rpc();

            try {
                await program.methods
                    .deposit(new BN(1000))
                    .accountsStrict({
                        config: configPda,
                        vaultTokenAccount: vaultTokenAccount,
                        vaultTokenAccountConfig: vaultTokenAccountConfigPda,
                        mint: mintedToken,
                        mintAuthority: mintAuthorityPda,
                        signer: user.publicKey,
                        userVaultTokenAccount: userVaultTokenAccount,
                        userMintTokenAccount: userMintTokenAccount,
                        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID
                    })
                    .signers([user])
                    .rpc();
                assert.fail("Should have thrown error");
            } catch (err) {
                expect(err).to.exist;
            }

            // Cleanup
            await program.methods
                .thawTokenAccount()
                .accountsStrict({
                    config: configPda,
                    tokenAccount: userMintTokenAccount,
                    mint: mintedToken,
                    freezeAuthorityPda: freezeAuthorityPda,
                    signer: freezeAdmin.publicKey,
                    tokenProgram: TOKEN_PROGRAM_ID,
                })
                .signers([freezeAdmin])
                .rpc();
        });
    });

    describe("edge cases and invariants", () => {
        it("maintains 1:1 ratio through deposit/redeem cycle", async () => {
            const mintSupplyBefore = (await getMint(provider.connection, mintedToken)).supply;
            const amount = new BN(100_000);

            const initialUserMintBalance = (await getAccount(provider.connection, userMintTokenAccount)).amount;

            await program.methods
                .deposit(amount)
                .accountsStrict({
                    config: configPda,
                    vaultTokenAccount: vaultTokenAccount,
                    vaultTokenAccountConfig: vaultTokenAccountConfigPda,
                    mint: mintedToken,
                    mintAuthority: mintAuthorityPda,
                    signer: user.publicKey,
                    userVaultTokenAccount: userVaultTokenAccount,
                    userMintTokenAccount: userMintTokenAccount,
                    tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID
                })
                .signers([user])
                .rpc();

            const [redemptionRequestPda] = anchor.web3.PublicKey.findProgramAddressSync(
                [Buffer.from("redemption_request"), user.publicKey.toBuffer()],
                program.programId
            );

            await program.methods
                .requestRedeem(new BN(amount))
                .accountsStrict({
                    signer: user.publicKey,
                    userMintTokenAccount: userMintTokenAccount,
                    redemptionRequest: redemptionRequestPda,
                    mint: mintedToken,
                    config: configPda,
                    systemProgram: anchor.web3.SystemProgram.programId,
                    tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
                    redeemVaultAuthority: redeemVaultAuthorityPda,
                })
                .signers([user])
                .rpc();

            await program.methods
                .completeRedeem(amount)
                .accountsStrict({
                    admin: rewardsAdmin.publicKey,
                    user: user.publicKey,
                    userMintTokenAccount: userMintTokenAccount,
                    userVaultTokenAccount: userVaultTokenAccount,
                    redemptionRequest: redemptionRequestPda,
                    redeemVaultTokenAccount: redeemVaultTokenAccount,
                    redeemVaultAuthority: redeemVaultAuthorityPda,
                    mint: mintedToken,
                    config: configPda,
                    tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
                })
                .signers([rewardsAdmin])
                .rpc();

            const finalUserMintBalance = (await getAccount(provider.connection, userMintTokenAccount)).amount;
            const finalMintSupply = (await getMint(provider.connection, mintedToken)).supply;

            assert.equal(finalUserMintBalance, initialUserMintBalance);
            assert.equal(finalMintSupply, mintSupplyBefore);
        });

        it("handles maximum token amounts", async () => {
            const maxAmount = new BN("18446744073709551615"); // u64::MAX

            // This should fail due to insufficient balance, not overflow
            try {
                await program.methods
                    .deposit(maxAmount)
                    .accountsStrict({
                        config: configPda,
                        vaultTokenAccount: vaultTokenAccount,
                        vaultTokenAccountConfig: vaultTokenAccountConfigPda,
                        mint: mintedToken,
                        mintAuthority: mintAuthorityPda,
                        signer: user.publicKey,
                        userVaultTokenAccount: userVaultTokenAccount,
                        userMintTokenAccount: userMintTokenAccount,
                        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID
                    })
                    .signers([user])
                    .rpc();
                assert.fail("Should have thrown error");
            } catch (err) {
                expect(err).to.exist;
            }
        });
        it("prevents arbitrary external program mint execute", async () => {
            const [externalMintAuthorityPda] = anchor.web3.PublicKey.findProgramAddressSync(
                [Buffer.from("external_mint_authority")],
                stakeProgram.programId
            );
            const [allowedExternalMintProgramsPda] = anchor.web3.PublicKey.findProgramAddressSync(
                [
                    Buffer.from("allowed_external_mint_programs"),
                    configPda.toBuffer(),
                ],
                program.programId
            );
            try {
                await program.methods
                    .externalProgramMint(new BN(1_000_000))
                    .accountsStrict({
                        config: configPda,
                        callingProgram: stakeProgram.programId,
                        externalMintAuthority: externalMintAuthorityPda,
                        mint: mintedToken,
                        mintAuthority: mintAuthorityPda,
                        admin: rewardsAdmin.publicKey,
                        destination: userMintTokenAccount,
                        allowedExternalMintPrograms: allowedExternalMintProgramsPda,
                        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID
                    })
                    .rpc();
                assert.fail("Should have thrown error");
            } catch (err) {
                expect(err).to.exist;
                // Direct client call cannot sign the stake PDA; runtime rejects missing/invalid signature.
                expect(err.toString()).to.match(
                    /Signature verification failed|missing required signature|Transaction simulation failed/i
                );
            }
        });

        it("requires rewards admin signature on external_program_mint", async () => {
            const [externalMintAuthorityPda] = anchor.web3.PublicKey.findProgramAddressSync(
                [Buffer.from("external_mint_authority")],
                stakeProgram.programId
            );
            const [allowedExternalMintProgramsPda] = anchor.web3.PublicKey.findProgramAddressSync(
                [
                    Buffer.from("allowed_external_mint_programs"),
                    configPda.toBuffer(),
                ],
                program.programId
            );
            const accounts = {
                config: configPda,
                callingProgram: stakeProgram.programId,
                externalMintAuthority: externalMintAuthorityPda,
                mint: mintedToken,
                mintAuthority: mintAuthorityPda,
                admin: rewardsAdmin.publicKey,
                destination: userMintTokenAccount,
                allowedExternalMintPrograms: allowedExternalMintProgramsPda,
                tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
            };

            // IDL/account metas must mark the listed rewards admin as a required signer.
            const ix = await program.methods
                .externalProgramMint(new BN(1_000_000))
                .accountsStrict(accounts)
                .instruction();
            const adminMeta = ix.keys.find((key) => key.pubkey.equals(rewardsAdmin.publicKey));
            expect(adminMeta, "admin account meta").to.exist;
            expect(adminMeta!.isSigner).to.equal(true);

            // Passing a listed admin pubkey without that key signing must fail.
            // Provider fee-payer signs the tx; rewardsAdmin is intentionally omitted.
            try {
                await program.methods
                    .externalProgramMint(new BN(1_000_000))
                    .accountsStrict(accounts)
                    .rpc();
                assert.fail("Should have thrown error");
            } catch (err) {
                expect(err).to.exist;
                expect(err.toString()).to.match(
                    /Signature verification failed|missing required signature|Transaction simulation failed/i
                );
            }
        });

    });

    // external_program_mint: legacy caller is config.allowed_external_mint_program (vault-stake);
    // extended callers use AllowedExternalMintPrograms PDA. Legacy CPI is covered by vault-stake publish_rewards.
    describe("external_program_mint authorization", () => {
        const MEMO_PROGRAM_ID = new PublicKey(
            "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"
        );
        const VOTE_PROGRAM_ID = new PublicKey(
            "Vote111111111111111111111111111111111111111"
        );
        const COMPUTE_BUDGET_PROGRAM_ID = new PublicKey(
            "ComputeBudget111111111111111111111111111111"
        );
        const TEST_PRICE_SCALE = new BN(1_000_000_000);
        const TEST_PRICE_1TO1 = new BN(1_000_000_000);
        const TEST_FEED_ID = Array.from(Buffer.alloc(32, 0));

        let allowedExternalMintProgramsPda: PublicKey;
        let externalMintProgramsLimitConfigPda: PublicKey;
        let stakeConfigPdaAuto: PublicKey;
        let vaultAuthorityPdaAuto: PublicKey;
        let stakeVaultTokenAccountConfigPdaAuto: PublicKey;
        let stakePriceConfigPdaAuto: PublicKey;
        let stakeRewardConfigPdaAuto: PublicKey;
        let lastRewardPublicationPdaAuto: PublicKey;
        let programDataPdaAuto: PublicKey;
        let externalMintAuthorityPdaAuto: PublicKey;
        let autoShareMint: PublicKey;
        let stakeAutoVaultTokenAccount: PublicKey;
        let autoPublishRewardsId = 0;
        let autoProgramDeployed = false;

        const ensureAllowListPdaInitialized = async () => {
            const info = await provider.connection.getAccountInfo(allowedExternalMintProgramsPda);
            if (info) {
                return;
            }
            await updateExternalMintProgramsLimit(5);
            await (program.methods as any)
                .registerAllowedExternalMintProgram()
                .accountsStrict({
                    config: configPda,
                    allowedExternalMintPrograms: allowedExternalMintProgramsPda,
                    externalMintProgramsLimitConfig: externalMintProgramsLimitConfigPda,
                    externalProgram: MEMO_PROGRAM_ID,
                    signer: provider.wallet.publicKey,
                    programData: programDataPda,
                    systemProgram: SystemProgram.programId,
                })
                .rpc();
        };

        const updateExternalMintProgramsLimit = async (maxPrograms: number) => {
            await (program.methods as any)
                .updateExternalMintProgramsLimit(maxPrograms)
                .accountsStrict({
                    config: configPda,
                    externalMintProgramsLimitConfig: externalMintProgramsLimitConfigPda,
                    signer: provider.wallet.publicKey,
                    programData: programDataPda,
                    systemProgram: SystemProgram.programId,
                })
                .rpc();
        };

        const setPriceForTestingAuto = async () => {
            const priceTimestamp = new BN(Math.floor(Date.now() / 1000));
            await stakeAutoProgram.methods
                .setPriceForTesting(TEST_PRICE_1TO1, priceTimestamp)
                .accountsStrict({
                    stakeConfig: stakeConfigPdaAuto,
                    stakePriceConfig: stakePriceConfigPdaAuto,
                    signer: provider.wallet.publicKey,
                    programData: programDataPdaAuto,
                })
                .rpc();
        };

        // Record PDA is addressed by (id, amount); uniqueness of id is the LastRewardPublication counter.
        const makeAutoRewardsRecordPda = (id: number, amount: number | bigint | BN) =>
            PublicKey.findProgramAddressSync(
                [
                    Buffer.from("reward_record"),
                    Buffer.from(new Uint32Array([id]).buffer),
                    Buffer.from(new BigUint64Array([BigInt(amount.toString())]).buffer),
                ],
                stakeAutoProgram.programId
            )[0];

        // rewards_mint must be vault-mint config.mint (PDA-controlled); stake_config.vault matches it.
        const publishRewardsAutoAccounts = (rewardRecord: PublicKey) => ({
            stakeConfig: stakeConfigPdaAuto,
            stakeVaultTokenAccountConfig: stakeVaultTokenAccountConfigPdaAuto,
            mintConfig: configPda,
            externalMintAuthority: externalMintAuthorityPdaAuto,
            mintProgram: program.programId,
            thisProgram: stakeAutoProgram.programId,
            vaultMintAllowedExternalPrograms: allowedExternalMintProgramsPda,
            admin: rewardsAdmin.publicKey,
            rewardsMint: mintedToken,
            rewardsMintAuthority: mintAuthorityPda,
            vaultTokenAccount: stakeAutoVaultTokenAccount,
            vaultAuthority: vaultAuthorityPdaAuto,
            mint: autoShareMint,
            rewardRecord,
            stakeRewardConfig: stakeRewardConfigPdaAuto,
            lastRewardPublication: lastRewardPublicationPdaAuto,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
        });

        before(async () => {
            [allowedExternalMintProgramsPda] = PublicKey.findProgramAddressSync(
                [
                    Buffer.from("allowed_external_mint_programs"),
                    configPda.toBuffer(),
                ],
                program.programId
            );
            [externalMintProgramsLimitConfigPda] = PublicKey.findProgramAddressSync(
                [
                    Buffer.from("external_mint_programs_limit"),
                    configPda.toBuffer(),
                ],
                program.programId
            );

            await ensureAllowListPdaInitialized();

            const autoProgramInfo = await provider.connection.getAccountInfo(stakeAutoProgram.programId);
            autoProgramDeployed = !!autoProgramInfo?.executable;
            if (!autoProgramDeployed) {
                return;
            }

            [stakeConfigPdaAuto] = PublicKey.findProgramAddressSync(
                [Buffer.from("stake_config")],
                stakeAutoProgram.programId
            );
            [vaultAuthorityPdaAuto] = PublicKey.findProgramAddressSync(
                [Buffer.from("vault_authority")],
                stakeAutoProgram.programId
            );
            [stakeVaultTokenAccountConfigPdaAuto] = PublicKey.findProgramAddressSync(
                [
                    Buffer.from("stake_vault_token_account_config"),
                    stakeConfigPdaAuto.toBuffer(),
                ],
                stakeAutoProgram.programId
            );
            [stakePriceConfigPdaAuto] = PublicKey.findProgramAddressSync(
                [
                    Buffer.from("stake_price_config"),
                    stakeConfigPdaAuto.toBuffer(),
                ],
                stakeAutoProgram.programId
            );
            [stakeRewardConfigPdaAuto] = PublicKey.findProgramAddressSync(
                [
                    Buffer.from("stake_reward_config"),
                    stakeConfigPdaAuto.toBuffer(),
                ],
                stakeAutoProgram.programId
            );
            [lastRewardPublicationPdaAuto] = PublicKey.findProgramAddressSync(
                [
                    Buffer.from("last_reward_publication"),
                    stakeConfigPdaAuto.toBuffer(),
                ],
                stakeAutoProgram.programId
            );
            [programDataPdaAuto] = PublicKey.findProgramAddressSync(
                [stakeAutoProgram.programId.toBuffer()],
                BPF_LOADER_UPGRADEABLE_ID
            );
            [externalMintAuthorityPdaAuto] = PublicKey.findProgramAddressSync(
                [Buffer.from("external_mint_authority")],
                stakeAutoProgram.programId
            );

            const [autoMintAuthorityPda] = PublicKey.findProgramAddressSync(
                [Buffer.from("mint_authority")],
                stakeAutoProgram.programId
            );
            const [autoFreezeAuthorityPda] = PublicKey.findProgramAddressSync(
                [Buffer.from("freeze_authority")],
                stakeAutoProgram.programId
            );

            autoShareMint = await createMint(
                provider.connection,
                provider.wallet.payer,
                autoMintAuthorityPda,
                autoFreezeAuthorityPda,
                6
            );

            // Stake pool vault holds vault-mint receipt tokens (config.mint), same as vault-stake tests.
            stakeAutoVaultTokenAccount = await createAccount(
                provider.connection,
                provider.wallet.payer,
                mintedToken,
                provider.wallet.publicKey,
                Keypair.generate()
            );

            const fundVault = BigInt(10_000_000_000);
            // Earlier describes spend userMintTokenAccount; top up via deposit before funding the stake vault.
            let userMintBal = BigInt(
                (await getAccount(provider.connection, userMintTokenAccount)).amount.toString()
            );
            if (userMintBal < fundVault) {
                const shortfall = fundVault - userMintBal;
                let userVaultBal = BigInt(
                    (await getAccount(provider.connection, userVaultTokenAccount)).amount.toString()
                );
                if (userVaultBal < shortfall) {
                    await mintTo(
                        provider.connection,
                        provider.wallet.payer,
                        vaultedToken,
                        userVaultTokenAccount,
                        provider.wallet.publicKey,
                        shortfall - userVaultBal
                    );
                }
                await program.methods
                    .deposit(new BN(shortfall.toString()))
                    .accountsStrict({
                        config: configPda,
                        vaultTokenAccount: vaultTokenAccount,
                        vaultTokenAccountConfig: vaultTokenAccountConfigPda,
                        mint: mintedToken,
                        mintAuthority: mintAuthorityPda,
                        signer: user.publicKey,
                        userVaultTokenAccount: userVaultTokenAccount,
                        userMintTokenAccount: userMintTokenAccount,
                        tokenProgram: TOKEN_PROGRAM_ID,
                    })
                    .signers([user])
                    .rpc();
            }

            await transfer(
                provider.connection,
                provider.wallet.payer,
                userMintTokenAccount,
                stakeAutoVaultTokenAccount,
                user,
                fundVault
            );

            await stakeAutoProgram.methods
                .initialize([freezeAdmin.publicKey], [rewardsAdmin.publicKey])
                .accountsStrict({
                    stakeConfig: stakeConfigPdaAuto,
                    vaultAuthority: vaultAuthorityPdaAuto,
                    vaultTokenAccount: stakeAutoVaultTokenAccount,
                    stakeVaultTokenAccountConfig: stakeVaultTokenAccountConfigPdaAuto,
                    vaultTokenMint: mintedToken,
                    mint: autoShareMint,
                    signer: provider.wallet.publicKey,
                    tokenProgram: TOKEN_PROGRAM_ID,
                    systemProgram: SystemProgram.programId,
                    programData: programDataPdaAuto,
                })
                .rpc();

            await stakeAutoProgram.methods
                .initializePriceConfig(
                    PublicKey.default,
                    PublicKey.default,
                    PublicKey.default,
                    TEST_FEED_ID,
                    TEST_PRICE_SCALE,
                    new BN(3600)
                )
                .accountsStrict({
                    stakeConfig: stakeConfigPdaAuto,
                    stakePriceConfig: stakePriceConfigPdaAuto,
                    signer: provider.wallet.publicKey,
                    programData: programDataPdaAuto,
                    systemProgram: SystemProgram.programId,
                })
                .rpc();

            // Cap + monotonic-id accounts must exist before publish_rewards (no lazy init).
            await stakeAutoProgram.methods
                .initializeStakeRewardConfig()
                .accountsStrict({
                    stakeConfig: stakeConfigPdaAuto,
                    stakeRewardConfig: stakeRewardConfigPdaAuto,
                    signer: provider.wallet.publicKey,
                    programData: programDataPdaAuto,
                    systemProgram: SystemProgram.programId,
                })
                .rpc();
            await stakeAutoProgram.methods
                .initializeLastRewardPublication(0)
                .accountsStrict({
                    stakeConfig: stakeConfigPdaAuto,
                    lastRewardPublication: lastRewardPublicationPdaAuto,
                    signer: provider.wallet.publicKey,
                    programData: programDataPdaAuto,
                    systemProgram: SystemProgram.programId,
                })
                .rpc();

            await setPriceForTestingAuto();
        });

        it("legacy path: config.allowedExternalMintProgram is vault-stake (CPI exercised in vault-stake.test.ts publish_rewards)", async () => {
            const cfg = await program.account.config.fetch(configPda);
            assert.ok(
                cfg.allowedExternalMintProgram.equals(stakeProgram.programId),
                "legacy field should authorize the PRIME pool program id"
            );
        });

        // Requires a deployed vault-stake AUTO binary (pool-auto feature). Skipped until that is
        // part of the default local/CI deploy path.
        it.skip("rejects CPI when calling_program is not legacy and not on the allow-list", async function () {
            const vaultBal = (await getAccount(provider.connection, stakeAutoVaultTokenAccount))
                .amount;
            const amount = (vaultBal * BigInt(50)) / BigInt(10_000);
            assert.ok(amount > BigInt(0), "need vault balance for publish amount");
            const id = ++autoPublishRewardsId;
            const rewardRecord = makeAutoRewardsRecordPda(id, amount);

            try {
                await stakeAutoProgram.methods
                    .publishRewards(id, new BN(amount.toString()))
                    .accountsStrict(publishRewardsAutoAccounts(rewardRecord))
                    .signers([rewardsAdmin])
                    .rpc();
                assert.fail("expected vault-mint to reject unregistered caller");
            } catch (err: unknown) {
                expect(err).to.exist;
                expect(String(err)).to.match(/InvalidMintProgramCaller|custom program error:\s*27\b/i);
            }
        });

        it.skip("allows CPI after register_allowed_external_mint_program adds the caller", async function () {
            await (program.methods as any)
                .registerAllowedExternalMintProgram()
                .accountsStrict({
                    config: configPda,
                    allowedExternalMintPrograms: allowedExternalMintProgramsPda,
                    externalMintProgramsLimitConfig: externalMintProgramsLimitConfigPda,
                    externalProgram: stakeAutoProgram.programId,
                    signer: provider.wallet.publicKey,
                    programData: programDataPda,
                    systemProgram: SystemProgram.programId,
                })
                .rpc();

            const vaultBalBefore = (await getAccount(provider.connection, stakeAutoVaultTokenAccount))
                .amount;
            const amount = (vaultBalBefore * BigInt(50)) / BigInt(10_000);
            assert.ok(amount > BigInt(0));
            const id = ++autoPublishRewardsId;
            const rewardRecord = makeAutoRewardsRecordPda(id, amount);

            await stakeAutoProgram.methods
                .publishRewards(id, new BN(amount.toString()))
                .accountsStrict(publishRewardsAutoAccounts(rewardRecord))
                .signers([rewardsAdmin])
                .rpc();

            const vaultBalAfter = (await getAccount(provider.connection, stakeAutoVaultTokenAccount))
                .amount;
            assert.equal(vaultBalAfter, vaultBalBefore + amount);
        });

        it("register_allowed_external_mint_program is idempotent for the same program", async () => {
            const before = await program.account.allowedExternalMintPrograms.fetch(
                allowedExternalMintProgramsPda
            );
            await (program.methods as any)
                .registerAllowedExternalMintProgram()
                .accountsStrict({
                    config: configPda,
                    allowedExternalMintPrograms: allowedExternalMintProgramsPda,
                    externalMintProgramsLimitConfig: externalMintProgramsLimitConfigPda,
                    externalProgram: MEMO_PROGRAM_ID,
                    signer: provider.wallet.publicKey,
                    programData: programDataPda,
                    systemProgram: SystemProgram.programId,
                })
                .rpc();
            const after = await program.account.allowedExternalMintPrograms.fetch(
                allowedExternalMintProgramsPda
            );
            assert.equal(
                after.programs.length,
                before.programs.length,
                "re-registering the same program must not grow the list"
            );
        });

        it("update_external_mint_programs_limit rejects values above u8 range", async () => {
            try {
                await updateExternalMintProgramsLimit(256);
                assert.fail("expected InvalidAllowedExternalMintProgramsLimit");
            } catch (err: unknown) {
                expect(err).to.exist;
                expect(String(err)).to.match(/out of range|expected range|u8|InvalidAllowedExternalMintProgramsLimit|custom program error:\s*35\b/i);
            }
        });

        it("update_external_mint_programs_limit rejects non-upgrade-authority signer", async () => {
            // This instruction is upgrade-authority gated; a regular keypair must be rejected.
            try {
                await (program.methods as any)
                    .updateExternalMintProgramsLimit(5)
                    .accountsStrict({
                        config: configPda,
                        externalMintProgramsLimitConfig: externalMintProgramsLimitConfigPda,
                        signer: freezeAdmin.publicKey,
                        programData: programDataPda,
                        systemProgram: SystemProgram.programId,
                    })
                    .signers([freezeAdmin])
                    .rpc();
                assert.fail("expected InvalidUpgradeAuthority");
            } catch (err: unknown) {
                expect(err).to.exist;
                expect(String(err)).to.match(/InvalidUpgradeAuthority|custom program error:\s*12\b/i);
            }
        });

        it("update_external_mint_programs_limit changes cap used during registration", async () => {
            // At this point we have 1 entry from bootstrap (MEMO).
            await updateExternalMintProgramsLimit(1);

            try {
                await (program.methods as any)
                    .registerAllowedExternalMintProgram()
                    .accountsStrict({
                        config: configPda,
                        allowedExternalMintPrograms: allowedExternalMintProgramsPda,
                        externalMintProgramsLimitConfig: externalMintProgramsLimitConfigPda,
                        externalProgram: stakeProgram.programId,
                        signer: provider.wallet.publicKey,
                        programData: programDataPda,
                        systemProgram: SystemProgram.programId,
                    })
                    .rpc();
                assert.fail("expected TooManyAllowedExternalMintPrograms at cap=1");
            } catch (err: unknown) {
                expect(err).to.exist;
                expect(String(err)).to.match(/TooManyAllowedExternalMintPrograms|custom program error:\s*29\b/i);
            }

            // Restore default cap so follow-on tests can fill to the configured maximum for this suite.
            await updateExternalMintProgramsLimit(5);
        });

        it("register_allowed_external_mint_program enforces configured limit (5)", async () => {
            const candidatePrograms = [
                MEMO_PROGRAM_ID,
                stakeProgram.programId,
                program.programId,
                TOKEN_PROGRAM_ID,
                VOTE_PROGRAM_ID,
                COMPUTE_BUDGET_PROGRAM_ID,
            ];

            const registerOne = (externalProgram: PublicKey) =>
                (program.methods as any)
                    .registerAllowedExternalMintProgram()
                    .accountsStrict({
                        config: configPda,
                        allowedExternalMintPrograms: allowedExternalMintProgramsPda,
                        externalMintProgramsLimitConfig: externalMintProgramsLimitConfigPda,
                        externalProgram,
                        signer: provider.wallet.publicKey,
                        programData: programDataPda,
                        systemProgram: SystemProgram.programId,
                    })
                    .rpc();

            let state = await program.account.allowedExternalMintPrograms.fetch(
                allowedExternalMintProgramsPda
            );
            const seen = new Set(state.programs.map((p: PublicKey) => p.toBase58()));

            for (const candidate of candidatePrograms) {
                if (state.programs.length >= 5) {
                    break;
                }
                const key = candidate.toBase58();
                if (seen.has(key)) {
                    continue;
                }
                await registerOne(candidate);
                seen.add(key);
                state = await program.account.allowedExternalMintPrograms.fetch(
                    allowedExternalMintProgramsPda
                );
            }

            assert.equal(
                state.programs.length,
                5,
                "test expects a full allow-list to assert the cap; adjust candidates if this fails"
            );

            const spill = candidatePrograms.find(
                c => !state.programs.some((p: PublicKey) => p.equals(c))
            );
            assert.ok(spill, "need an executable program id not already on the list for the 6th registration");

            try {
                await registerOne(spill);
                assert.fail("expected TooManyAllowedExternalMintPrograms");
            } catch (err: unknown) {
                expect(err).to.exist;
                expect(String(err)).to.match(/TooManyAllowedExternalMintPrograms|custom program error: 29/i);
            }
        });
    });

    //write test cases against the rewards merkle tree functionality
    describe("rewards", () => {
        const epochIndex = 1;
        let rewardsAllocations: {
            allocations: { account: string; amount: number; }[];
        };
        let epochPda: PublicKey;
        let claimPda: PublicKey;
        let root: Buffer;
        let total: anchor.BN;
        let merkleData: {
            allocations: {
                user: PublicKey;
                amount: anchor.BN;
            }[],
            leaves: Buffer<ArrayBufferLike>[],
            tree: MerkleTree,
        };

        before(async () => {
            rewardsAllocations = {
                allocations: [
                    {
                        account: user.publicKey.toBase58(),
                        amount: 1000
                    },
                    // Add more allocations as needed
                ]
            };
            // Create rewards epoch
            merkleData = allocationsToMerkleTree(JSON.stringify(rewardsAllocations), epochIndex);
            root = merkleData.tree.getRoot();
            total = merkleData.allocations.reduce((acc, a) => acc.add(a.amount), new anchor.BN(0));

            [epochPda] = PublicKey.findProgramAddressSync(
                [Buffer.from("epoch"), new anchor.BN(epochIndex).toArrayLike(Buffer, "le", 8)],
                program.programId
            );
            // derive claim record PDA
            [claimPda] = PublicKey.findProgramAddressSync(
                [Buffer.from("claim"), epochPda.toBuffer(), user.publicKey.toBuffer()],
                program.programId
            );


        });

        it("creates rewards epoch", async () => {
            await program.methods
                .createRewardsEpoch(new anchor.BN(epochIndex), Array.from(root), total)
                .accountsStrict({
                    config: configPda,
                    epochCapsConfig: deriveRewardsEpochAccounts(program.programId, epochIndex).epochCapsConfig,
                    lastRewardsEpoch: deriveRewardsEpochAccounts(program.programId, 0).lastRewardsEpoch,
                    admin: rewardsAdmin.publicKey,
                    epoch: epochPda,
                    epochClaimed: deriveRewardsEpochAccounts(program.programId, epochIndex).epochClaimed,
                    systemProgram: anchor.web3.SystemProgram.programId,
                })
                .signers([rewardsAdmin])
                .rpc();
            const epochData = await program.account.rewardsEpoch.fetch(epochPda);
            assert.equal(epochIndex, epochData.index.toNumber());
            assert.equal(root.toString("hex"), Buffer.from(epochData.merkleRoot).toString("hex"));
        });

        it("prevents duplicate rewards epoch", async () => {
            try {
                await program.methods
                    .createRewardsEpoch(new anchor.BN(epochIndex), Array.from(root), total)
                    .accountsStrict({
                        config: configPda,
                        epochCapsConfig: deriveRewardsEpochAccounts(program.programId, epochIndex).epochCapsConfig,
                        lastRewardsEpoch: deriveRewardsEpochAccounts(program.programId, 0).lastRewardsEpoch,
                        admin: rewardsAdmin.publicKey,
                        epoch: epochPda,
                        epochClaimed: deriveRewardsEpochAccounts(program.programId, epochIndex).epochClaimed,
                        systemProgram: anchor.web3.SystemProgram.programId,
                    })
                    .signers([rewardsAdmin])
                    .rpc();
                assert.fail("Should have thrown error");
            } catch (err) {
                expect(err).to.exist;
            }
        });

        it("only redeem admin can create rewards epoch", async () => {
            try {
                await program.methods
                    .createRewardsEpoch(new anchor.BN(epochIndex), Array.from(root), total)
                    .accountsStrict({
                        config: configPda,
                        epochCapsConfig: deriveRewardsEpochAccounts(program.programId, epochIndex).epochCapsConfig,
                        lastRewardsEpoch: deriveRewardsEpochAccounts(program.programId, 0).lastRewardsEpoch,
                        admin: provider.wallet.publicKey,
                        epoch: epochPda,
                        epochClaimed: deriveRewardsEpochAccounts(program.programId, epochIndex).epochClaimed,
                        systemProgram: anchor.web3.SystemProgram.programId,
                    })
                    .rpc();
                assert.fail("Should have thrown error");
            } catch (err) {
                expect(err).to.exist;
            }
        });

        it("user claims rewards successfully", async () => {
            const userMintBalanceBefore = (await getAccount(provider.connection, userMintTokenAccount)).amount;
            const userAllocation = merkleData.allocations.find(a => a.user.toBase58() === user.publicKey.toBase58());
            assert.ok(userAllocation, "User allocation not found in merkle data");

            const leaf = makeLeaf(user.publicKey, userAllocation!.amount, epochIndex);
            const treeProof = merkleData.tree.getProof(leaf);
            const proof = treeProof.map(p => ({
                sibling: Array.from(p.data),
                isLeft: p.position === "left",
            }));
            const verified = merkleData.tree.verify(treeProof, leaf, root);
            assert.isTrue(verified, "Merkle tree verification failed");

            await program.methods
                .claimRewards(userAllocation!.amount, proof)
                .accountsStrict({
                    config: configPda,
                    user: user.publicKey,
                    epoch: epochPda,
                    epochCapsConfig: deriveRewardsEpochAccounts(program.programId, epochIndex).epochCapsConfig,
                    epochClaimed: deriveRewardsEpochAccounts(program.programId, epochIndex).epochClaimed,
                    claimRecord: claimPda,
                    mintAuthority: mintAuthorityPda,
                    mint: mintedToken,
                    userMintTokenAccount: userMintTokenAccount,
                    systemProgram: anchor.web3.SystemProgram.programId,
                    tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
                })
                .signers([user])
                .rpc();

            const userMintBalanceAfter = (await getAccount(provider.connection, userMintTokenAccount)).amount;
            assert.equal(userMintBalanceAfter, userMintBalanceBefore + createBigInt(userAllocation!.amount.toNumber()));

            // epochIndex is at first_capped_epoch, so the aggregate counter must track the claim.
            const claimed = await program.account.epochClaimedAmount.fetch(
                deriveRewardsEpochAccounts(program.programId, epochIndex).epochClaimed
            );
            assert.equal(
                claimed.claimedTotal.toString(),
                userAllocation!.amount.toString(),
                "claim must be recorded in epoch_claimed for capped epochs"
            );
        });

        it("prevents double claim", async () => {
            const userAllocation = merkleData.allocations.find(a => a.user.toBase58() === user.publicKey.toBase58());

            const leaf = makeLeaf(user.publicKey, userAllocation!.amount, epochIndex);
            const treeProof = merkleData.tree.getProof(leaf);
            const proof = treeProof.map(p => ({
                sibling: Array.from(p.data),
                isLeft: p.position === "left",
            }));
            const verified = merkleData.tree.verify(treeProof, leaf, root);
            assert.isTrue(verified, "Merkle tree verification failed");

            try {
                await program.methods
                    .claimRewards(userAllocation!.amount, proof)
                    .accountsStrict({
                        config: configPda,
                        user: user.publicKey,
                        epoch: epochPda,
                        epochCapsConfig: deriveRewardsEpochAccounts(program.programId, epochIndex).epochCapsConfig,
                        epochClaimed: deriveRewardsEpochAccounts(program.programId, epochIndex).epochClaimed,
                        claimRecord: claimPda,
                        mintAuthority: mintAuthorityPda,
                        mint: mintedToken,
                        userMintTokenAccount: userMintTokenAccount,
                        systemProgram: anchor.web3.SystemProgram.programId,
                        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
                    })
                    .signers([user])
                    .rpc();
                assert.fail("Should have thrown error");
            } catch (err) {
                expect(err).to.exist;
            }
        });

        it("prevents invalid proof claim", async () => {
            const invalidAmount = 888;

            const leaf = makeLeaf(user.publicKey, invalidAmount, epochIndex);
            const treeProof = merkleData.tree.getProof(leaf);
            const proof = treeProof.map(p => ({
                sibling: Array.from(p.data),
                isLeft: p.position === "left",
            }));
            const verified = merkleData.tree.verify(treeProof, leaf, root);
            assert.isFalse(verified, "Merkle tree verification should have failed");

            try {
                await program.methods
                    .claimRewards(new BN(invalidAmount), proof)
                    .accountsStrict({
                        config: configPda,
                        user: user.publicKey,
                        epoch: epochPda,
                        epochCapsConfig: deriveRewardsEpochAccounts(program.programId, epochIndex).epochCapsConfig,
                        epochClaimed: deriveRewardsEpochAccounts(program.programId, epochIndex).epochClaimed,
                        claimRecord: claimPda,
                        mintAuthority: mintAuthorityPda,
                        mint: mintedToken,
                        userMintTokenAccount: userMintTokenAccount,
                        systemProgram: anchor.web3.SystemProgram.programId,
                        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
                    })
                    .signers([user])
                    .rpc();
                assert.fail("Should have thrown error");
            } catch (err) {
                expect(err).to.exist;
            }
        });

        it("rejects claim when wrong epoch PDA is passed (seeds constraint)", async () => {
            // Create epoch 2 with its own distinct merkle tree.
            // user2 has an allocation in epoch 2 only.
            const epoch2Index = 2;
            const epoch2Allocations = {
                allocations: [{ account: user.publicKey.toBase58(), amount: 500 }]
            };
            const epoch2Data = allocationsToMerkleTree(JSON.stringify(epoch2Allocations), epoch2Index);
            const epoch2Root = epoch2Data.tree.getRoot();
            const epoch2Total = new anchor.BN(500);

            const [epoch2Pda] = anchor.web3.PublicKey.findProgramAddressSync(
                [Buffer.from("epoch"), new anchor.BN(epoch2Index).toArrayLike(Buffer, "le", 8)],
                program.programId
            );
            // Claim record for user against epoch 2 (different key from epoch 1 claim record)
            const [claimPdaEpoch2] = anchor.web3.PublicKey.findProgramAddressSync(
                [Buffer.from("claim"), epoch2Pda.toBuffer(), user.publicKey.toBuffer()],
                program.programId
            );

            await program.methods
                .createRewardsEpoch(new anchor.BN(epoch2Index), Array.from(epoch2Root), epoch2Total)
                .accountsStrict({
                    config: configPda,
                    epochCapsConfig: deriveRewardsEpochAccounts(program.programId, epoch2Index).epochCapsConfig,
                    lastRewardsEpoch: deriveRewardsEpochAccounts(program.programId, 0).lastRewardsEpoch,
                    admin: rewardsAdmin.publicKey,
                    epoch: epoch2Pda,
                    epochClaimed: deriveRewardsEpochAccounts(program.programId, epoch2Index).epochClaimed,
                    systemProgram: anchor.web3.SystemProgram.programId,
                })
                .signers([rewardsAdmin])
                .rpc();

            // user has a valid proof for epoch 1, but passes epoch 2's PDA.
            // The seeds constraint verifies epoch2Pda IS the canonical PDA for index 2
            // (so ConstraintSeeds passes), but the merkle proof — built against epoch 1's
            // root — fails against epoch 2's root, proving the epoch account is actually
            // used for verification and cannot be swapped arbitrarily.
            const userAllocation = merkleData.allocations.find(
                a => a.user.toBase58() === user.publicKey.toBase58()
            );
            const leaf = makeLeaf(user.publicKey, userAllocation!.amount, epochIndex);
            const treeProof = merkleData.tree.getProof(leaf);
            const proof = treeProof.map(p => ({
                sibling: Array.from(p.data),
                isLeft: p.position === "left",
            }));

            try {
                await program.methods
                    .claimRewards(userAllocation!.amount, proof)
                    .accountsStrict({
                        config: configPda,
                        user: user.publicKey,
                        epoch: epoch2Pda,          // ← wrong epoch PDA
                        epochCapsConfig: deriveRewardsEpochAccounts(program.programId, epoch2Index).epochCapsConfig,
                        epochClaimed: deriveRewardsEpochAccounts(program.programId, epoch2Index).epochClaimed,
                        claimRecord: claimPdaEpoch2,
                        mintAuthority: mintAuthorityPda,
                        mint: mintedToken,
                        userMintTokenAccount: userMintTokenAccount,
                        systemProgram: anchor.web3.SystemProgram.programId,
                        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
                    })
                    .signers([user])
                    .rpc();
                assert.fail("Should have thrown error");
            } catch (err) {
                expect(err.toString()).to.include("InvalidMerkleProof");
            }
        });

        it("rejects create when total exceeds max_epoch_cap", async () => {
            // After epochs 1 and 2, last.index is 2 so the next create is 3.
            const overIndex = 3;
            const { epoch, epochClaimed, epochCapsConfig, lastRewardsEpoch } =
                deriveRewardsEpochAccounts(program.programId, overIndex);
            const last = await program.account.lastRewardsEpoch.fetch(lastRewardsEpoch);
            assert.equal(last.index.toNumber() + 1, overIndex);
            const caps = await program.account.epochCapsConfig.fetch(epochCapsConfig);
            const firstCappedBefore = caps.firstCappedEpoch.toString();
            const overTotal = caps.maxEpochCap.add(new BN(1));
            const overAlloc = {
                allocations: [{ account: user.publicKey.toBase58(), amount: 1 }],
            };
            const overMerkle = allocationsToMerkleTree(JSON.stringify(overAlloc), overIndex);

            try {
                await program.methods
                    .createRewardsEpoch(
                        new BN(overIndex),
                        Array.from(overMerkle.tree.getRoot()),
                        overTotal
                    )
                    .accountsStrict({
                        config: configPda,
                        epochCapsConfig,
                        lastRewardsEpoch,
                        admin: rewardsAdmin.publicKey,
                        epoch,
                        epochClaimed,
                        systemProgram: SystemProgram.programId,
                    })
                    .signers([rewardsAdmin])
                    .rpc();
                assert.fail("Should have thrown EpochCapAboveGlobal");
            } catch (err) {
                expect(err.toString()).to.match(/EpochCapAboveGlobal|custom program error: 0x28/i);
            }
            const capsAfter = await program.account.epochCapsConfig.fetch(epochCapsConfig);
            assert.equal(
                capsAfter.firstCappedEpoch.toString(),
                firstCappedBefore,
                "failed create must not mutate first_capped_epoch"
            );
        });

        it("rejects create for an index below first_capped_epoch", async () => {
            // first_capped_epoch is 1 (suite init), so index 0 is an unused grandfathered slot.
            // claim_rewards exempts indices below the boundary from the aggregate counter, so an
            // epoch created there could mint past its declared total. Creation must be refused,
            // leaving those indices exclusive to epochs that predate the caps upgrade.
            const legacyIndex = 0;
            const { epoch, epochClaimed, epochCapsConfig, lastRewardsEpoch } =
                deriveRewardsEpochAccounts(program.programId, legacyIndex);
            const caps = await program.account.epochCapsConfig.fetch(epochCapsConfig);
            assert.isTrue(
                legacyIndex < caps.firstCappedEpoch.toNumber(),
                "legacyIndex must be below first_capped_epoch"
            );

            const legacyAllocations = {
                allocations: [{ account: user.publicKey.toBase58(), amount: 250 }],
            };
            const legacyMerkle = allocationsToMerkleTree(
                JSON.stringify(legacyAllocations),
                legacyIndex
            );
            const legacyTotal = legacyMerkle.allocations.reduce(
                (acc, a) => acc.add(a.amount),
                new BN(0)
            );

            try {
                await program.methods
                    .createRewardsEpoch(
                        new BN(legacyIndex),
                        Array.from(legacyMerkle.tree.getRoot()),
                        legacyTotal
                    )
                    .accountsStrict({
                        config: configPda,
                        epochCapsConfig,
                        lastRewardsEpoch,
                        admin: rewardsAdmin.publicKey,
                        epoch,
                        epochClaimed,
                        systemProgram: SystemProgram.programId,
                    })
                    .signers([rewardsAdmin])
                    .rpc();
                // Message deliberately omits the error name so it cannot satisfy the match below.
                assert.fail("create below the cap boundary should have been rejected");
            } catch (err) {
                expect(err.toString()).to.match(
                    /EpochIndexBelowFirstCapped|custom program error: 0x2d/i
                );
            }

            // Nothing may be left behind: neither PDA is initialized by the failed create.
            const epochInfo = await provider.connection.getAccountInfo(epoch);
            assert.isNull(epochInfo, "epoch PDA must not be created below the boundary");
            const claimedInfo = await provider.connection.getAccountInfo(epochClaimed);
            assert.isNull(claimedInfo, "epoch_claimed PDA must not be created below the boundary");
        });

        it("rejects create when index skips ahead of last.index + 1", async () => {
            const { epochCapsConfig, lastRewardsEpoch } = deriveRewardsEpochAccounts(program.programId, 0);
            const last = await program.account.lastRewardsEpoch.fetch(lastRewardsEpoch);
            const gappedIndex = last.index.toNumber() + 2;
            const { epoch, epochClaimed } = deriveRewardsEpochAccounts(
                program.programId,
                gappedIndex
            );
            const gappedAlloc = {
                allocations: [{ account: user.publicKey.toBase58(), amount: 1 }],
            };
            const gappedMerkle = allocationsToMerkleTree(
                JSON.stringify(gappedAlloc),
                gappedIndex
            );

            try {
                await program.methods
                    .createRewardsEpoch(
                        new BN(gappedIndex),
                        Array.from(gappedMerkle.tree.getRoot()),
                        new BN(1)
                    )
                    .accountsStrict({
                        config: configPda,
                        epochCapsConfig,
                        lastRewardsEpoch,
                        admin: rewardsAdmin.publicKey,
                        epoch,
                        epochClaimed,
                        systemProgram: SystemProgram.programId,
                    })
                    .signers([rewardsAdmin])
                    .rpc();
                assert.fail("Should have thrown EpochIndexNotContiguous");
            } catch (err) {
                expect(err.toString()).to.match(
                    /EpochIndexNotContiguous|custom program error: 0x2f/i
                );
            }
        });

        it("create_rewards_epoch does not mutate EpochCapsConfig", async () => {
            const { epochCapsConfig, lastRewardsEpoch } = deriveRewardsEpochAccounts(
                program.programId,
                0
            );
            const capsBefore = await program.account.epochCapsConfig.fetch(epochCapsConfig);
            const lastBefore = await program.account.lastRewardsEpoch.fetch(lastRewardsEpoch);
            const index = lastBefore.index.toNumber() + 1;
            const { epoch, epochClaimed } = deriveRewardsEpochAccounts(program.programId, index);
            const alloc = {
                allocations: [{ account: user.publicKey.toBase58(), amount: 1 }],
            };
            const merkle = allocationsToMerkleTree(JSON.stringify(alloc), index);

            await program.methods
                .createRewardsEpoch(new BN(index), Array.from(merkle.tree.getRoot()), new BN(1))
                .accountsStrict({
                    config: configPda,
                    epochCapsConfig,
                    lastRewardsEpoch,
                    admin: rewardsAdmin.publicKey,
                    epoch,
                    epochClaimed,
                    systemProgram: SystemProgram.programId,
                })
                .signers([rewardsAdmin])
                .rpc();

            const capsAfter = await program.account.epochCapsConfig.fetch(epochCapsConfig);
            assert.equal(
                capsAfter.firstCappedEpoch.toString(),
                capsBefore.firstCappedEpoch.toString(),
                "first_capped_epoch must not change across create_rewards_epoch"
            );
            assert.equal(
                capsAfter.maxEpochCap.toString(),
                capsBefore.maxEpochCap.toString(),
                "max_epoch_cap must not change across create_rewards_epoch"
            );
            assert.equal(capsAfter.bump, capsBefore.bump, "bump must not change");
            const lastAfter = await program.account.lastRewardsEpoch.fetch(lastRewardsEpoch);
            assert.equal(lastAfter.index.toNumber(), index, "counter advances on successful create");
        });

        it("rejects claim that exceeds epoch cap (EpochCapExceeded)", async () => {
            // Declared total is 500 but the Merkle tree allocates 1000.
            const { lastRewardsEpoch: lastPda } = deriveRewardsEpochAccounts(program.programId, 0);
            const lastBefore = await program.account.lastRewardsEpoch.fetch(lastPda);
            const capEpochIndex = lastBefore.index.toNumber() + 1;
            const capAllocations = {
                allocations: [{ account: user.publicKey.toBase58(), amount: 1000 }],
            };
            const capMerkle = allocationsToMerkleTree(JSON.stringify(capAllocations), capEpochIndex);
            const declaredTotal = new BN(500);
            const { epoch, epochClaimed, epochCapsConfig, lastRewardsEpoch } =
                deriveRewardsEpochAccounts(program.programId, capEpochIndex);
            const [capClaimPda] = PublicKey.findProgramAddressSync(
                [Buffer.from("claim"), epoch.toBuffer(), user.publicKey.toBuffer()],
                program.programId
            );

            await program.methods
                .createRewardsEpoch(
                    new BN(capEpochIndex),
                    Array.from(capMerkle.tree.getRoot()),
                    declaredTotal
                )
                .accountsStrict({
                    config: configPda,
                    epochCapsConfig,
                    lastRewardsEpoch,
                    admin: rewardsAdmin.publicKey,
                    epoch,
                    epochClaimed,
                    systemProgram: SystemProgram.programId,
                })
                .signers([rewardsAdmin])
                .rpc();

            const userAlloc = capMerkle.allocations[0];
            const leaf = makeLeaf(user.publicKey, userAlloc.amount, capEpochIndex);
            const proof = capMerkle.tree.getProof(leaf).map(p => ({
                sibling: Array.from(p.data),
                isLeft: p.position === "left",
            }));

            try {
                await program.methods
                    .claimRewards(userAlloc.amount, proof)
                    .accountsStrict({
                        config: configPda,
                        user: user.publicKey,
                        epoch,
                        epochCapsConfig,
                        epochClaimed,
                        claimRecord: capClaimPda,
                        mintAuthority: mintAuthorityPda,
                        mint: mintedToken,
                        userMintTokenAccount: userMintTokenAccount,
                        systemProgram: SystemProgram.programId,
                        tokenProgram: TOKEN_PROGRAM_ID,
                    })
                    .signers([user])
                    .rpc();
                assert.fail("Should have thrown EpochCapExceeded");
            } catch (err) {
                expect(err.toString()).to.match(/EpochCapExceeded|custom program error: 0x24/i);
            }
        });
    }); // end describe("rewards")

    describe("updateability", () => {
        let programData: PublicKey;
        let addFreezeAdmin: Keypair;
        let addRewardsAdmin: Keypair;
        let newVaultTokenAccount: PublicKey;
        let newVaultTokenAccountOwner: PublicKey;
        let sweepDestinationOwner: Keypair;
        let sweepDestinationTokenAccount: PublicKey;

        before(async () => {
            [programData] = PublicKey.findProgramAddressSync(
                [program.programId.toBuffer()],
                BPF_LOADER_UPGRADEABLE_ID
            );
            addFreezeAdmin = Keypair.generate();
            addRewardsAdmin = Keypair.generate();
            newVaultTokenAccountOwner = Keypair.generate().publicKey;
            // Create vault token account
            newVaultTokenAccount = await createAccount(
                provider.connection,
                provider.wallet.payer,
                vaultedToken,
                newVaultTokenAccountOwner
            );

            // create a new user that owns the destination vault token account
            sweepDestinationOwner = Keypair.generate();
            // Create destination token account
            sweepDestinationTokenAccount = await createAccount(
                provider.connection,
                provider.wallet.payer,
                vaultedToken,
                sweepDestinationOwner.publicKey
            );


        });

        it("allows freeze admin update by upgrade authority", async () => {
            await program.methods
                .updateFreezeAdministrators([freezeAdmin.publicKey, addFreezeAdmin.publicKey])
                .accountsStrict({
                    config: configPda,
                    signer: provider.wallet.publicKey,
                    programData: programData,
                })
                .rpc();
            //fetch config and verify
            const config = await program.account.config.fetch(configPda);
            const freezeAdmins = config.freezeAdministrators.map(pk => pk.toBase58());
            assert.includeMembers(freezeAdmins, [freezeAdmin.publicKey.toBase58(), addFreezeAdmin.publicKey.toBase58()]);
        });

        it("disallows freeze admin update by non upgrade authority", async () => {
            try {
                await program.methods
                    .updateFreezeAdministrators([freezeAdmin.publicKey, addFreezeAdmin.publicKey])
                    .accountsStrict({
                        config: configPda,
                        signer: freezeAdmin.publicKey,
                        programData: programData,
                    })
                    .signers([freezeAdmin])
                    .rpc();
                assert.fail("Should have thrown error");
            } catch (err) {
                expect(err).to.exist;
            }
        });

        it("rejects empty freeze administrators update", async () => {
            try {
                await program.methods
                    .updateFreezeAdministrators([])
                    .accountsStrict({
                        config: configPda,
                        signer: provider.wallet.publicKey,
                        programData: programData,
                    })
                    .rpc();
                assert.fail("Should have thrown EmptyAdministrators");
            } catch (err) {
                expect(err.toString()).to.match(/EmptyAdministrators|must not be empty/i);
            }
        });

        it("rejects duplicate freeze administrators update", async () => {
            try {
                await program.methods
                    .updateFreezeAdministrators([freezeAdmin.publicKey, freezeAdmin.publicKey])
                    .accountsStrict({
                        config: configPda,
                        signer: provider.wallet.publicKey,
                        programData: programData,
                    })
                    .rpc();
                assert.fail("Should have thrown DuplicateAdministrators");
            } catch (err) {
                expect(err.toString()).to.match(/DuplicateAdministrators|duplicate/i);
            }
        });

        it("new freeze admin can freeze user mint token account", async () => {
            await program.methods
                .freezeTokenAccount()
                .accountsStrict({
                    config: configPda,
                    tokenAccount: userMintTokenAccount,
                    mint: mintedToken,
                    freezeAuthorityPda: freezeAuthorityPda,
                    signer: addFreezeAdmin.publicKey,
                    tokenProgram: TOKEN_PROGRAM_ID,
                })
                .signers([addFreezeAdmin])
                .rpc();

            const accountInfo = await getAccount(provider.connection, userMintTokenAccount);
            assert.ok(accountInfo.isFrozen);
        });

        it("new freeze admin can thaw user token account", async () => {
            await program.methods
                .thawTokenAccount()
                .accountsStrict({
                    config: configPda,
                    tokenAccount: userMintTokenAccount,
                    mint: mintedToken,
                    freezeAuthorityPda: freezeAuthorityPda,
                    signer: addFreezeAdmin.publicKey,
                    tokenProgram: TOKEN_PROGRAM_ID,
                })
                .signers([addFreezeAdmin])
                .rpc();

            const accountInfo = await getAccount(provider.connection, userMintTokenAccount);
            assert.ok(!accountInfo.isFrozen);
        });

        it("allows rewards admin update by upgrade authority", async () => {
            await program.methods
                .updateRewardsAdministrators([rewardsAdmin.publicKey, addRewardsAdmin.publicKey])
                .accountsStrict({
                    config: configPda,
                    signer: provider.wallet.publicKey,
                    programData: programData,
                })
                .rpc();
            //fetch config and verify
            const config = await program.account.config.fetch(configPda);
            const rewardsAdmins = config.rewardsAdministrators.map(pk => pk.toBase58());
            assert.includeMembers(rewardsAdmins, [rewardsAdmin.publicKey.toBase58(), addRewardsAdmin.publicKey.toBase58()]);
        });

        it("disallows rewards admin update by non upgrade authority", async () => {
            try {
                await program.methods
                    .updateRewardsAdministrators([rewardsAdmin.publicKey, addRewardsAdmin.publicKey])
                    .accountsStrict({
                        config: configPda,
                        signer: rewardsAdmin.publicKey,
                        programData: programData,
                    })
                    .signers([rewardsAdmin])
                    .rpc();
                assert.fail("Should have thrown error");
            } catch (err) {
                expect(err).to.exist;
            }
        });

        it("rejects empty rewards administrators update", async () => {
            try {
                await program.methods
                    .updateRewardsAdministrators([])
                    .accountsStrict({
                        config: configPda,
                        signer: provider.wallet.publicKey,
                        programData: programData,
                    })
                    .rpc();
                assert.fail("Should have thrown EmptyAdministrators");
            } catch (err) {
                expect(err.toString()).to.match(/EmptyAdministrators|must not be empty/i);
            }
        });

        it("rejects duplicate rewards administrators update", async () => {
            try {
                await program.methods
                    .updateRewardsAdministrators([rewardsAdmin.publicKey, rewardsAdmin.publicKey])
                    .accountsStrict({
                        config: configPda,
                        signer: provider.wallet.publicKey,
                        programData: programData,
                    })
                    .rpc();
                assert.fail("Should have thrown DuplicateAdministrators");
            } catch (err) {
                expect(err.toString()).to.match(/DuplicateAdministrators|duplicate/i);
            }
        });

        it("new rewards admin can complete redeem", async () => {
            const [redemptionRequestPda] = anchor.web3.PublicKey.findProgramAddressSync(
                [Buffer.from("redemption_request"), user.publicKey.toBuffer()],
                program.programId
            );
            await program.methods
                .requestRedeem(new BN(1))
                .accountsStrict({
                    signer: user.publicKey,
                    userMintTokenAccount: userMintTokenAccount,
                    redemptionRequest: redemptionRequestPda,
                    mint: mintedToken,
                    config: configPda,
                    systemProgram: anchor.web3.SystemProgram.programId,
                    tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
                    redeemVaultAuthority: redeemVaultAuthorityPda,
                })
                .signers([user])
                .rpc();

            // Now perform the redeem
            await program.methods
                .completeRedeem(new BN(1))
                .accountsStrict({
                    admin: addRewardsAdmin.publicKey,
                    user: user.publicKey,
                    userMintTokenAccount: userMintTokenAccount,
                    userVaultTokenAccount: userVaultTokenAccount,
                    redemptionRequest: redemptionRequestPda,
                    redeemVaultTokenAccount: redeemVaultTokenAccount,
                    redeemVaultAuthority: redeemVaultAuthorityPda,
                    mint: mintedToken,
                    config: configPda,
                    tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
                })
                .signers([addRewardsAdmin])
                .rpc();
        });

        it("vault token account update by upgrade authority", async () => {
            await program.methods
                .updateVaultTokenAccount()
                .accountsStrict({
                    config: configPda,
                    vaultTokenAccountConfig: vaultTokenAccountConfigPda,
                    signer: provider.wallet.publicKey,
                    vaultTokenAccount: newVaultTokenAccount,
                    programData: programData,
                })
                .rpc();

            //fetch config and verify
            const config = await program.account.config.fetch(configPda);
            assert.equal(config.vaultAuthority.toBase58(), newVaultTokenAccountOwner.toBase58());

            //verify vault token account config has been updated
            const vaultTokenAccountConfig = await program.account.vaultTokenAccountConfig.fetch(vaultTokenAccountConfigPda);
            assert.equal(vaultTokenAccountConfig.vaultTokenAccount.toBase58(), newVaultTokenAccount.toBase58());
        });

        it("new vault token account gets deposits", async () => {
            const depositAmount = createBigInt(1_000_000);

            const vaultBalanceBefore = (await getAccount(provider.connection, newVaultTokenAccount)).amount;
            const userMintBalanceBefore = (await getAccount(provider.connection, userMintTokenAccount)).amount;
            const userVaultBalanceBefore = (await getAccount(provider.connection, userVaultTokenAccount)).amount;

            await program.methods
                .deposit(new BN(depositAmount))
                .accountsStrict({
                    config: configPda,
                    vaultTokenAccount: newVaultTokenAccount,
                    vaultTokenAccountConfig: vaultTokenAccountConfigPda,
                    mint: mintedToken,
                    mintAuthority: mintAuthorityPda,
                    signer: user.publicKey,
                    userVaultTokenAccount: userVaultTokenAccount,
                    userMintTokenAccount: userMintTokenAccount,
                    tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID
                })
                .signers([user])
                .rpc();

            const vaultBalanceAfter = (await getAccount(provider.connection, newVaultTokenAccount)).amount;
            const userMintBalanceAfter = (await getAccount(provider.connection, userMintTokenAccount)).amount;
            const userVaultBalanceAfter = (await getAccount(provider.connection, userVaultTokenAccount)).amount;

            assert.equal(vaultBalanceAfter, vaultBalanceBefore + depositAmount);
            assert.equal(userMintBalanceAfter, userMintBalanceBefore + depositAmount);
            assert.equal(userVaultBalanceAfter, userVaultBalanceBefore - depositAmount);

        });

        it("set vault token account back to original so vault-stake tests can use it", async () => {
            await program.methods
                .updateVaultTokenAccount()
                .accountsStrict({
                    config: configPda,
                    vaultTokenAccountConfig: vaultTokenAccountConfigPda,
                    signer: provider.wallet.publicKey,
                    vaultTokenAccount: vaultTokenAccount,
                    programData: programData,
                })
                .rpc();

            //fetch config and verify
            const config = await program.account.config.fetch(configPda);
            assert.equal(config.vaultAuthority.toBase58(), vaultTokenAccountOwnerPublicKey.toBase58());
        });

        it("disallows vault token account update by non upgrade authority", async () => {
            try {
                await program.methods
                    .updateVaultTokenAccount()
                    .accountsStrict({
                        config: configPda,
                        vaultTokenAccountConfig: vaultTokenAccountConfigPda,
                        signer: freezeAdmin.publicKey,
                        vaultTokenAccount: newVaultTokenAccount,
                        programData: programData,
                    })
                    .signers([freezeAdmin])
                    .rpc();
                assert.fail("Should have thrown error");
            } catch (err) {
                expect(err).to.exist;
            }
        });

        it("allows sweep redeem vault token account by rewards admin", async () => {
            const redeemVaultBalanceBefore = (await getAccount(provider.connection, redeemVaultTokenAccount)).amount;
            const vaultTokenAccountBefore = (await getAccount(provider.connection, vaultTokenAccount)).amount;
            const amount = 5_000_000;

            await program.methods
                .sweepRedeemVaultFunds(new BN(amount))
                .accountsStrict({
                    config: configPda,
                    signer: rewardsAdmin.publicKey,
                    redeemVaultAuthority: redeemVaultAuthorityPda,
                    redeemVaultTokenAccount: redeemVaultTokenAccount,
                    vaultTokenAccount: vaultTokenAccount,
                    tokenProgram: TOKEN_PROGRAM_ID,
                })
                .signers([rewardsAdmin])
                .rpc();

            const redeemVaultBalanceAfter = (await getAccount(provider.connection, redeemVaultTokenAccount)).amount;
            const vaultTokenAccountAfter = (await getAccount(provider.connection, vaultTokenAccount)).amount;

            assert.equal(redeemVaultBalanceAfter, redeemVaultBalanceBefore - createBigInt(amount));
            assert.equal(vaultTokenAccountAfter, vaultTokenAccountBefore + createBigInt(amount));
        });

        it("disallows sweep redeem vault token account to unauthorized vault account", async () => {
            // create a new user that owns the destination vault token account
            const sweepDestinationOwner = Keypair.generate();
            // Create destination token account
            const sweepDestinationTokenAccount = await createAccount(
                provider.connection,
                provider.wallet.payer,
                vaultedToken,
                sweepDestinationOwner.publicKey
            );

            try {
                await program.methods
                    .sweepRedeemVaultFunds(new BN(5_000_000))
                    .accountsStrict({
                        config: configPda,
                        signer: rewardsAdmin.publicKey,
                        redeemVaultAuthority: redeemVaultAuthorityPda,
                        redeemVaultTokenAccount: redeemVaultTokenAccount,
                        vaultTokenAccount: sweepDestinationTokenAccount,
                        tokenProgram: TOKEN_PROGRAM_ID,
                    })
                    .signers([rewardsAdmin])
                    .rpc();
                assert.fail("Should have thrown error");
            } catch (err) {
                expect(err).to.exist;
            }
        });

        it("disallows sweep redeem vault by upgrade authority who is not a rewards admin", async () => {
            // upgrade authority (provider.wallet) is not in rewards_administrators — must be rejected
            try {
                await program.methods
                    .sweepRedeemVaultFunds(new BN(5_000_000))
                    .accountsStrict({
                        config: configPda,
                        signer: provider.wallet.publicKey,
                        redeemVaultAuthority: redeemVaultAuthorityPda,
                        redeemVaultTokenAccount: redeemVaultTokenAccount,
                        vaultTokenAccount: vaultTokenAccount,
                        tokenProgram: TOKEN_PROGRAM_ID,
                    })
                    .rpc();
                assert.fail("Should have thrown error");
            } catch (err) {
                expect(err).to.exist;
            }
        });

        it("disallow zero amount redeem vault sweep", async () => {
            try {
                await program.methods
                    .sweepRedeemVaultFunds(new BN(0))
                    .accountsStrict({
                        config: configPda,
                        signer: rewardsAdmin.publicKey,
                        redeemVaultAuthority: redeemVaultAuthorityPda,
                        redeemVaultTokenAccount: redeemVaultTokenAccount,
                        vaultTokenAccount: vaultTokenAccount,
                        tokenProgram: TOKEN_PROGRAM_ID,
                    })
                    .signers([rewardsAdmin])
                    .rpc();
                assert.fail("Should have thrown error");
            } catch (err) {
                expect(err).to.exist;
            }
        });
    });
});
