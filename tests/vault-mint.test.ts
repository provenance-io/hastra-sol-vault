import * as anchor from "@coral-xyz/anchor";
import {Program} from "@coral-xyz/anchor";
import {VaultMint} from "../target/types/vault_mint";
import {VaultStake} from "../target/types/vault_stake";
import {Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram} from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";
import {
    createAccount,
    createMint,
    getAccount,
    getMint,
    mintTo,
    TOKEN_PROGRAM_ID,
    transfer,
} from "@solana/spl-token";
import {assert, expect} from "chai";
import BN from "bn.js";
import {createBigInt} from "@metaplex-foundation/umi";
import {allocationsToMerkleTree, makeLeaf} from "../scripts/cryptolib";
import {MerkleTree} from "merkletreejs";

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
                .completeRedeem() // Amount is calculated in the function
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

        it("complete fails with no open redemption request", async () => {
            try {
                await program.methods
                    .completeRedeem()
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
                .completeRedeem() // Amount is calculated in the function
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
                    .completeRedeem() // Amount is calculated in the function
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
                .completeRedeem() // Amount is calculated in the function
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
                        admin: rewardsAdmin.publicKey,
                        epoch: pausedEpochPda,
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
                .completeRedeem() // Amount is calculated in the function
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

        const makeAutoRewardsRecordPda = (id: number, amount: bigint) =>
            PublicKey.findProgramAddressSync(
                [
                    Buffer.from("reward_record"),
                    Buffer.from(new Uint32Array([id]).buffer),
                    Buffer.from(new BigUint64Array([amount]).buffer),
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

            // stake_reward_config for AUTO is created lazily on first publish_rewards.

            await setPriceForTestingAuto();
        });

        it("legacy path: config.allowedExternalMintProgram is vault-stake (CPI exercised in vault-stake.test.ts publish_rewards)", async () => {
            const cfg = await program.account.config.fetch(configPda);
            assert.ok(
                cfg.allowedExternalMintProgram.equals(stakeProgram.programId),
                "legacy field should authorize the PRIME pool program id"
            );
        });

        it("rejects CPI when calling_program is not legacy and not on the allow-list", async function () {
            if (!autoProgramDeployed) {
                this.skip();
                return;
            }
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

        it("allows CPI after register_allowed_external_mint_program adds the caller", async function () {
            if (!autoProgramDeployed) {
                this.skip();
                return;
            }
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
                    admin: rewardsAdmin.publicKey,
                    epoch: epochPda,
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
                        admin: rewardsAdmin.publicKey,
                        epoch: epochPda,
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
                        admin: provider.wallet.publicKey,
                        epoch: epochPda,
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
                    admin: rewardsAdmin.publicKey,
                    epoch: epoch2Pda,
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
                .completeRedeem() // Amount is calculated in the function
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
