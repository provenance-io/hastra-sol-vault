import * as anchor from "@coral-xyz/anchor";
import {Program} from "@coral-xyz/anchor";
import {VaultMint} from "../target/types/vault_mint";
import {VaultStake} from "../target/types/vault_stake";
import {Keypair, LAMPORTS_PER_SOL, PublicKey} from "@solana/web3.js";
import {
    createAccount,
    createMint,
    getAccount,
    getMint,
    mintTo,
    TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {assert, expect} from "chai";
import BN from "bn.js";
import {createBigInt} from "@metaplex-foundation/umi";
import {allocationsToMerkleTree, makeLeaf} from "../scripts/cryptolib";
import {MerkleTree} from "merkletreejs";

describe("vault-mint", () => {
    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);

    const program = anchor.workspace.VaultMint as Program<VaultMint>;
    const stakeProgram = anchor.workspace.VaultStake as Program<VaultStake>;

    let mintedToken: PublicKey;
    let vaultedToken: PublicKey;
    let vaultTokenAccount: PublicKey;
    let vaultTokenAccountOwner: PublicKey;
    let redeemVaultTokenAccount: PublicKey;
    let configPda: PublicKey;
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
        freezeAdmin = Keypair.generate();
        rewardsAdmin = Keypair.fromSeed(Buffer.alloc(32, 31)); // Deterministic owner
        vaultTokenAccountOwner = Keypair.fromSeed(Buffer.alloc(32, 72)).publicKey; // Deterministic owner
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
        await provider.connection.requestAirdrop(user.publicKey, 10 * LAMPORTS_PER_SOL);
        await provider.connection.requestAirdrop(freezeAdmin.publicKey, 2 * LAMPORTS_PER_SOL);
        await provider.connection.requestAirdrop(rewardsAdmin.publicKey, 2 * LAMPORTS_PER_SOL);
        await provider.connection.requestAirdrop(redeemVaultAuthorityPda, 10 * LAMPORTS_PER_SOL);

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

        [programDataPda] = PublicKey.findProgramAddressSync(
            [program.programId.toBuffer()],
            BPF_LOADER_UPGRADEABLE_ID
        );

        // Create vault token account
        vaultTokenAccount = await createAccount(
            provider.connection,
            provider.wallet.payer,
            vaultedToken,
            vaultTokenAccountOwner
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

    });

    describe("initialize", () => {
        it("fails with too many freeze administrators", async () => {
            const tooManyAdmins = Array(6).fill(Keypair.generate().publicKey);
            try {
                await program.methods
                    .initialize(tooManyAdmins, [rewardsAdmin.publicKey])
                    .accounts({
                        signer: provider.wallet.publicKey,
                        vaultTokenAccount: vaultTokenAccount,
                        vaultTokenMint: vaultedToken,
                        allowedExternalMintProgram: stakeProgram.programId,
                        redeemVaultTokenAccount: vaultTokenAccount,
                        mint: mintedToken,
                        programData: programDataPda,
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
                    .accounts({
                        signer: provider.wallet.publicKey,
                        vaultTokenAccount: vaultTokenAccount,
                        vaultTokenMint: vaultedToken,
                        allowedExternalMintProgram: stakeProgram.programId,
                        redeemVaultTokenAccount: vaultTokenAccount,
                        mint: mintedToken,
                        programData: programDataPda,
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
                .accounts({
                    signer: provider.wallet.publicKey,
                    vaultTokenAccount: vaultTokenAccount,
                    vaultTokenMint: vaultedToken,
                    redeemVaultTokenAccount: redeemVaultTokenAccount,
                    allowedExternalMintProgram: stakeProgram.programId,
                    mint: mintedToken,
                    programData: programDataPda,
                })
                .rpc();

            const config = await program.account.config.fetch(configPda);
            assert.ok(config.vault.equals(vaultedToken));
            assert.ok(config.vaultAuthority.equals(vaultTokenAccountOwner));
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
                    .accounts({
                        signer: provider.wallet.publicKey,
                        vaultTokenAccount: vaultTokenAccount,
                        vaultTokenMint: vaultedToken,
                        allowedExternalMintProgram: stakeProgram.programId,
                        redeemVaultTokenAccount: vaultTokenAccount,
                        mint: mintedToken,
                        programData: programDataPda,
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
        let programData: PublicKey;

        before(async () => {
            [programData] = PublicKey.findProgramAddressSync(
                [program.programId.toBuffer()],
                BPF_LOADER_UPGRADEABLE_ID
            );
        });

        it("pauses all functionality", async () => {
            await program.methods
                .pause(true)
                .accountsStrict({
                    config: configPda,
                    programData: programData,
                    signer: provider.wallet.publicKey,
                })
                .rpc();

            const config = await program.account.config.fetch(configPda);
            assert.isTrue(config.paused);
        });

        it("fails pause when called by non upgrade authority", async () => {
            try {
                await program.methods
                    .pause(true)
                    .accountsStrict({
                        config: configPda,
                        programData: programData,
                        signer: freezeAdmin.publicKey,
                    })
                    .signers([freezeAdmin])
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
            }
        });

        it("unpauses", async () => {
            await program.methods
                .pause(false)
                .accountsStrict({
                    config: configPda,
                    programData: programData,
                    signer: provider.wallet.publicKey,
                })
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
    });

    //write test cases against the rewards merkle tree functionality
    describe("rewards", () => {
        const epochIndex = 1;
        let rewardsAllocations: { allocations: { account: string; amount: number; }[]; };
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
                    {  account: user.publicKey.toBase58(),
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
            const treeProof =  merkleData.tree.getProof(leaf);
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
            const treeProof =  merkleData.tree.getProof(leaf);
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
            const userAllocation = merkleData.allocations.find(a => a.user.toBase58() === user.publicKey.toBase58());
            const invalidAmount = 888;

            const leaf = makeLeaf(user.publicKey, invalidAmount, epochIndex);
            const treeProof =  merkleData.tree.getProof(leaf);
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
    });

    describe("updateability", () => {
        let programData: PublicKey;
        let addFreezeAdmin: Keypair;
        let addRewardsAdmin: Keypair;
        let newVaultTokenAccount: PublicKey;
        let newVaultTokenAccountOwner: PublicKey;

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
                    signer: provider.wallet.publicKey,
                    vaultTokenAccount: newVaultTokenAccount,
                    programData: programData,
                })
                .rpc();

            //fetch config and verify
            const config = await program.account.config.fetch(configPda);
            assert.equal(config.vaultAuthority.toBase58(), newVaultTokenAccountOwner.toBase58());
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
                    signer: provider.wallet.publicKey,
                    vaultTokenAccount: vaultTokenAccount,
                    programData: programData,
                })
                .rpc();

            //fetch config and verify
            const config = await program.account.config.fetch(configPda);
            assert.equal(config.vaultAuthority.toBase58(), vaultTokenAccountOwner.toBase58());
        });

    });
});
