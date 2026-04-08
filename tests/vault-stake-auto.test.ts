/**
 * Integration tests for vault-stake-auto (AUTO pool). Structure mirrors `vault-stake.test.ts`.
 * Mocha runs `vault-mint.test.ts` before this file (lexical order). vault-mint may bootstrap this
 * program for external_program_mint tests; `before` and initialize tests tolerate existing PDAs.
 */
import * as anchor from "@coral-xyz/anchor";
import {Program} from "@coral-xyz/anchor";
import {VaultMint} from "../target/types/vault_mint";
import {VaultStakeAuto} from "../target/types/vault_stake_auto";
import {
    Keypair,
    LAMPORTS_PER_SOL,
    PublicKey,
    SystemProgram
} from "@solana/web3.js";
import {
    createAccount,
    createMint,
    getAccount,
    getAssociatedTokenAddress,
    getMint,
    mintTo,
    TOKEN_PROGRAM_ID,
    transfer,
} from "@solana/spl-token";
import {assert, expect} from "chai";
import BN from "bn.js";
import {createBigInt} from "@metaplex-foundation/umi";
import {
    REWARD_COOLDOWN_TEST_SLEEP_MS,
    STAKE_REWARD_CONFIG_DEFAULTS,
    sleep,
} from "./helpers";

describe("vault-stake-auto", () => {
    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);

    const mintProgram = anchor.workspace.VaultMint as Program<VaultMint>;
    const program = anchor.workspace.VaultStakeAuto as Program<VaultStakeAuto>;

    // Helper: parse events from a confirmed transaction's log messages.
    // Derives the actual on-chain program ID from the transaction logs rather
    // than relying on the workspace program ID, making this robust to
    // `anchor keys sync` changing the declared ID in the IDL.
    const parseEvents = async (sig: string) => {
        const tx = await provider.connection.getTransaction(sig, {
            commitment: "confirmed",
            maxSupportedTransactionVersion: 0,
        });
        if (!tx?.meta?.logMessages) {
            console.log("DEBUG parseEvents: no logMessages for sig", sig);
            return [];
        }
        // Extract the actual program ID from the first invoke log line.
        const invokeLine = tx.meta.logMessages.find(l => l.includes("invoke [1]"));
        const actualProgramId = invokeLine
            ? new anchor.web3.PublicKey(invokeLine.split(" ")[1])
            : program.programId;
        console.log("DEBUG parseEvents: workspace programId =", program.programId.toBase58());
        console.log("DEBUG parseEvents: actualProgramId     =", actualProgramId.toBase58());
        console.log("DEBUG parseEvents: logMessages =", JSON.stringify(tx.meta.logMessages, null, 2));
        const eventParser = new anchor.EventParser(actualProgramId, program.coder);
        const events = [...eventParser.parseLogs(tx.meta.logMessages)];
        console.log("DEBUG parseEvents: parsed events =", JSON.stringify(events.map(e => e.name)));
        return events;
    };


    let mintedToken: PublicKey;
    let vaultedToken: PublicKey;
    let vaultTokenAccount: PublicKey;
    let badVaultTokenAccountOwner: Keypair;
    let badVaultTokenAccountOwnerPublicKey: PublicKey;
    let configPda: PublicKey;
    let vaultTokenAccountConfigPda: PublicKey;
    let stakeVaultTokenAccountConfigPda: PublicKey;
    let stakeConfigPda: PublicKey;
    let mintAuthorityPda: PublicKey;
    let vaultAuthorityPda: PublicKey;
    let freezeAuthorityPda: PublicKey;
    let programDataPda: PublicKey;
    /** vault-mint upgrade authority check for registerAllowedExternalMintProgram */
    let mintProgramDataPda: PublicKey;
    let allowedExternalMintProgramsPda: PublicKey;

    let user: Keypair;
    let user2: Keypair;
    let userMintTokenAccount: PublicKey;
    let userVaultTokenAccount: PublicKey;
    let user2MintTokenAccount: PublicKey;
    let user2VaultTokenAccount: PublicKey;
    /** User 2's USDC (vault) token account — set in initialize; not necessarily the ATA. */
    let user2MintProgramVaultedTokenAccount: PublicKey;
    let mintProgramVaultTokenAccount: PublicKey;
    let mintProgramVaultTokenAccountOwner: PublicKey;
    let externalMintAuthorityPda: PublicKey;
    let rewardsMintAuthorityPda: PublicKey;

    let freezeAdmin: Keypair;
    let rewardsAdmin: Keypair;

    let stakePriceConfigPda: PublicKey;
    let stakeRewardConfigPda: PublicKey;

    // Price config constants for testing.
    // price_scale = 1e9; price = 1e9 → 1:1 ratio (1 AUTO per 1 wYLDS, 1 wYLDS per 1 AUTO).
    // Deposit formula:  shares = amount * price_scale / price = amount (1:1 at these values)
    // Redeem formula:   wYLDS  = shares * price / price_scale = shares (1:1 at these values)
    const TEST_PRICE_SCALE = new BN(1_000_000_000);   // 1e9
    const TEST_PRICE_1TO1  = new BN(1_000_000_000);   // 1 AUTO per 1 wYLDS
    const TEST_FEED_ID= Array.from(Buffer.alloc(32, 0));

    let publishRewardsId = 0;

    const ONE_BIG_SHARE = createBigInt(1_000_000);
    const ONE_BIG_TOKEN = createBigInt(1_000_000);
    const BIG_ZERO = createBigInt(0);
    const hundredBillsLarge = createBigInt("100000000000000000"); //100 billion with 6 decimals

    const BPF_LOADER_UPGRADEABLE_ID = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");

    const parsedTransactionReturnData = async (sig: string): Promise<bigint> => {
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
            return createBigInt(new anchor.BN(buffer, "le").toNumber());
        }
        throw new Error("No parsed transaction return data");
    }

    const exchangeRate = async (): Promise<bigint> => {
        let sig = await program.methods.exchangeRate()
            .accountsStrict({
                stakeConfig: stakeConfigPda,
                mint: mintedToken,
                vaultTokenAccount: vaultTokenAccount,
                vaultAuthority: vaultAuthorityPda,
                stakePriceConfig: stakePriceConfigPda,
            })
            .rpc();
        //let the transaction bake
        await new Promise(resolve => setTimeout(resolve, 1000));
        return await parsedTransactionReturnData(sig);
    }

    /**
     * Sets price and timestamp directly in StakePriceConfig via the test-only instruction.
     * Uses the wallet upgrade authority (provider.wallet).
     * @param price      raw price value (i128 as BN) — at TEST_PRICE_SCALE this is wYLDS per AUTO
     * @param secondsAgo how many seconds in the past to backdate the price_timestamp
     */
    const setPriceForTesting = async (price: BN, secondsAgo = 0) => {
        const priceTimestamp = new BN(Math.floor(Date.now() / 1000) - secondsAgo);
        await program.methods
            .setPriceForTesting(price, priceTimestamp)
            .accountsStrict({
                stakeConfig: stakeConfigPda,
                stakePriceConfig: stakePriceConfigPda,
                signer: provider.wallet.publicKey,
                programData: programDataPda,
            })
            .rpc();
    };

    /** Accounts for upgrade-authority instructions that mutate StakeRewardConfig. */
    const stakeRewardConfigUpgradeAuthorityAccounts = () => ({
        stakeConfig: stakeConfigPda,
        stakeRewardConfig: stakeRewardConfigPda,
        signer: provider.wallet.publicKey,
        programData: programDataPda,
    });

    /**
     * Shorten reward cooldown to 1s so tests can chain publish_rewards without waiting for the
     * default ~59m period. Waits so on-chain unix time advances past last_reward + period.
     */
    const ensureShortRewardCooldownForTests = async () => {
        const info = await provider.connection.getAccountInfo(stakeRewardConfigPda);
        if (!info) return;
        await program.methods
            .updateRewardPeriodSeconds(new BN(1))
            .accountsStrict(stakeRewardConfigUpgradeAuthorityAccounts())
            .rpc();
        await sleep(REWARD_COOLDOWN_TEST_SLEEP_MS);
    };

    const vaultSummary = (title: string) => {
        let totalShares;
        let totalAssets;
        let rate;

        (async () => {
            totalShares = await getMint(provider.connection, mintedToken)
            totalAssets = await getAccount(provider.connection, vaultTokenAccount)
            rate = await exchangeRate();
        })().then(_ => {
                console.log(`\n======== ${title} ========`);
                console.table({
                    "Total Shares": totalShares.supply.toString(),
                    "Total Assets": totalAssets.amount.toString(),
                    "Exchange Rate (assets per share)": (() => { const s = rate.toString(); return s.length > 9 ? `${s.slice(0, -9)}.${s.slice(-9)}` : s; })(),
                });
            }
        );
    }
    before(async () => {
        // Setup keypairs
        user = Keypair.generate();
        user2 = Keypair.generate();
        freezeAdmin = Keypair.fromSeed(Buffer.alloc(32, 7)); // Deterministic admin to match mint admin
        rewardsAdmin = Keypair.fromSeed(Buffer.alloc(32, 31)); // Deterministic owner to match mint admin
        badVaultTokenAccountOwner = Keypair.generate();
        badVaultTokenAccountOwnerPublicKey = badVaultTokenAccountOwner.publicKey;

        [mintAuthorityPda] = PublicKey.findProgramAddressSync(
            [Buffer.from("mint_authority")],
            program.programId
        );

        [vaultAuthorityPda] = anchor.web3.PublicKey.findProgramAddressSync(
            [Buffer.from("vault_authority")],
            program.programId
        );

        [freezeAuthorityPda] = PublicKey.findProgramAddressSync(
            [Buffer.from("freeze_authority")],
            program.programId
        );

        [externalMintAuthorityPda] = anchor.web3.PublicKey.findProgramAddressSync(
            [Buffer.from("external_mint_authority")],
            program.programId
        );
        [rewardsMintAuthorityPda] = anchor.web3.PublicKey.findProgramAddressSync(
            [Buffer.from("mint_authority")],
            mintProgram.programId
        );

        // Airdrop SOL
        await provider.connection.requestAirdrop(user.publicKey, 100 * LAMPORTS_PER_SOL);
        await provider.connection.requestAirdrop(user2.publicKey, 100 * LAMPORTS_PER_SOL);
        await provider.connection.requestAirdrop(freezeAdmin.publicKey, 2 * LAMPORTS_PER_SOL);
        await provider.connection.requestAirdrop(rewardsAdmin.publicKey, 2 * LAMPORTS_PER_SOL);
        await provider.connection.requestAirdrop(badVaultTokenAccountOwnerPublicKey, 10 * LAMPORTS_PER_SOL);

        // Wait for airdrops
        await new Promise(resolve => setTimeout(resolve, 1000));

        // Derive PDAs first. vault-mint.test.ts may have already initialized this program.
        [configPda] = PublicKey.findProgramAddressSync(
            [Buffer.from("config")],
            mintProgram.programId
        );
        [vaultTokenAccountConfigPda] = PublicKey.findProgramAddressSync(
            [
                Buffer.from("vault_token_account_config"),
                configPda.toBuffer()
            ],
            mintProgram.programId
        );

        const mintConfig = await mintProgram.account.config.fetch(configPda);
        vaultedToken = mintConfig.mint;

        [stakeConfigPda] = PublicKey.findProgramAddressSync(
            [Buffer.from("stake_config")],
            program.programId
        );

        [stakeVaultTokenAccountConfigPda] = PublicKey.findProgramAddressSync(
            [
                Buffer.from("stake_vault_token_account_config"),
                stakeConfigPda.toBuffer()
            ],
            program.programId
        );

        [stakePriceConfigPda] = PublicKey.findProgramAddressSync(
            [
                Buffer.from("stake_price_config"),
                stakeConfigPda.toBuffer()
            ],
            program.programId
        );

        [stakeRewardConfigPda] = PublicKey.findProgramAddressSync(
            [
                Buffer.from("stake_reward_config"),
                stakeConfigPda.toBuffer()
            ],
            program.programId
        );

        [programDataPda] = PublicKey.findProgramAddressSync(
            [program.programId.toBuffer()],
            BPF_LOADER_UPGRADEABLE_ID
        );

        const stakeConfigExists = await provider.connection.getAccountInfo(stakeConfigPda);
        if (stakeConfigExists) {
            const sc = await program.account.stakeConfig.fetch(stakeConfigPda);
            mintedToken = sc.mint;
            const svc = await program.account.stakeVaultTokenAccountConfig.fetch(
                stakeVaultTokenAccountConfigPda
            );
            vaultTokenAccount = svc.vaultTokenAccount;
        } else {
            // Create mint token (e.g., AUTO) and pool vault for wYLDS (vault-mint receipt mint).
            mintedToken = await createMint(
                provider.connection,
                provider.wallet.payer,
                mintAuthorityPda,
                freezeAuthorityPda,
                6,
            );
            // Pass an explicit keypair so createAccount uses SystemProgram + initialize (not ATA create).
            vaultTokenAccount = await createAccount(
                provider.connection,
                provider.wallet.payer,
                vaultedToken,
                provider.wallet.publicKey,
                Keypair.generate()
            );
        }

        // Create user token accounts with user as owner
        userMintTokenAccount = await createAccount(
            provider.connection,
            provider.wallet.payer,
            mintedToken,
            user.publicKey,
            Keypair.generate()
        );

        userVaultTokenAccount = await createAccount(
            provider.connection,
            provider.wallet.payer,
            vaultedToken,
            user.publicKey,
            Keypair.generate()
        );

        user2MintTokenAccount = await createAccount(
            provider.connection,
            provider.wallet.payer,
            mintedToken,
            user2.publicKey,
            Keypair.generate()
        );

        user2VaultTokenAccount = await createAccount(
            provider.connection,
            provider.wallet.payer,
            vaultedToken,
            user2.publicKey,
            Keypair.generate()
        );

        mintProgramVaultTokenAccountOwner = Keypair.fromSeed(Buffer.alloc(32, 72)).publicKey;
        mintProgramVaultTokenAccount = await getAssociatedTokenAddress(
            mintConfig.vault,
            mintProgramVaultTokenAccountOwner
        );

        [mintProgramDataPda] = PublicKey.findProgramAddressSync(
            [mintProgram.programId.toBuffer()],
            BPF_LOADER_UPGRADEABLE_ID
        );
        [allowedExternalMintProgramsPda] = PublicKey.findProgramAddressSync(
            [
                Buffer.from("allowed_external_mint_programs"),
                configPda.toBuffer(),
            ],
            mintProgram.programId
        );

        // vault-mint initialize() sets legacy allowed_external_mint_program to vault-stake (PRIME)
        // only; register this program so publish_rewards CPI succeeds for vault-stake-auto.
        await mintProgram.methods
            .registerAllowedExternalMintProgram()
            .accountsStrict({
                config: configPda,
                allowedExternalMintPrograms: allowedExternalMintProgramsPda,
                externalProgram: program.programId,
                signer: provider.wallet.publicKey,
                programData: mintProgramDataPda,
                systemProgram: SystemProgram.programId,
            })
            .rpc();
    });

    after(async () => {
        vaultSummary("after test suite")
    })
    describe("initialize", () => {
        it("set up vault-mint deposit so user 1 has tokens to stake", async () => {
            const mintConfig = await mintProgram.account.config.fetch(configPda);

            const mintProgramVaultToken = mintConfig.vault; //USDC
            const userMintProgramVaultedTokenAccount = await createAccount(
                provider.connection,
                provider.wallet.payer,
                mintProgramVaultToken,
                user.publicKey,
                Keypair.generate()
            ); // USDC

            // Mint vault tokens to user (USDC)
            // we can do this as long as the wallet running the tests has ownership of the
            // mint program vault token account
            await mintTo(
                provider.connection,
                provider.wallet.payer,
                mintProgramVaultToken, //USDC
                userMintProgramVaultedTokenAccount, //USDC ATA
                provider.wallet.publicKey,
                100_000_000_000 // 100,000 USDC
            );

            const [mintAuthorityPda] = anchor.web3.PublicKey.findProgramAddressSync(
                [Buffer.from("mint_authority")],
                mintProgram.programId
            );
            // Deposit into vault-mint to receive minted tokens (wYLDS)
            // the program is already deployed and initialized, just need to deposit
            await mintProgram.methods
                .deposit(new BN(100_000_000_000)) // convert all 100,000 USDC
                .accountsStrict({
                    config: configPda,
                    vaultTokenAccountConfig: vaultTokenAccountConfigPda,
                    vaultTokenAccount: mintProgramVaultTokenAccount,
                    mint: vaultedToken,
                    mintAuthority: mintAuthorityPda,
                    signer: user.publicKey,
                    userVaultTokenAccount: userMintProgramVaultedTokenAccount, //USDC
                    userMintTokenAccount: userVaultTokenAccount,
                    tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID
                })
                .signers([user])
                .rpc();

            const userVaultedTokenBalance = await getAccount(provider.connection, userVaultTokenAccount);
            assert.equal(userVaultedTokenBalance.amount, createBigInt(100000_000_000));
        });

        it("set up vault-mint deposit so user 2 has a bajillion tokens to stake", async () => {
            const mintConfig = await mintProgram.account.config.fetch(configPda);

            const mintProgramVaultToken = mintConfig.vault; //USDC
            user2MintProgramVaultedTokenAccount = await createAccount(
                provider.connection,
                provider.wallet.payer,
                mintProgramVaultToken,
                user2.publicKey,
                Keypair.generate()
            ); // USDC

            // Mint vault tokens to user2 (USDC)
            // we can do this as long as the wallet running the tests has ownership of the
            // mint program vault token account
            await mintTo(
                provider.connection,
                provider.wallet.payer,
                mintProgramVaultToken, //USDC
                user2MintProgramVaultedTokenAccount, //USDC ATA
                provider.wallet.publicKey,
                (hundredBillsLarge + hundredBillsLarge)
            );
            const [mintAuthorityPda] = anchor.web3.PublicKey.findProgramAddressSync(
                [Buffer.from("mint_authority")],
                mintProgram.programId
            );
            // Deposit into vault-mint to receive minted tokens (wYLDS)
            // the program is already deployed and initialized, just need to deposit
            await mintProgram.methods
                .deposit(new BN(10_000_000_000)) // 10,000 tokens
                .accountsStrict({
                    config: configPda,
                    vaultTokenAccountConfig: vaultTokenAccountConfigPda,
                    vaultTokenAccount: mintProgramVaultTokenAccount,
                    mint: vaultedToken,
                    mintAuthority: mintAuthorityPda,
                    signer: user2.publicKey,
                    userVaultTokenAccount: user2MintProgramVaultedTokenAccount, //USDC
                    userMintTokenAccount: user2VaultTokenAccount,
                    tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID
                })
                .signers([user2])
                .rpc();

            const userVaultedTokenBalance = await getAccount(provider.connection, user2VaultTokenAccount);
            assert.equal(userVaultedTokenBalance.amount, createBigInt(10000_000_000));
        });

        it("fails with too many freeze administrators", async () => {
            const tooManyAdmins = Array(6).fill(Keypair.generate().publicKey);
            try {
                await program.methods
                    .initialize(tooManyAdmins, [rewardsAdmin.publicKey])
                    .accounts({
                        signer: provider.wallet.publicKey,
                        vaultTokenAccount: vaultTokenAccount,
                        vaultTokenMint: vaultedToken,
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
            const existing = await provider.connection.getAccountInfo(stakeConfigPda);
            if (existing) {
                const config = await program.account.stakeConfig.fetch(stakeConfigPda);
                assert.ok(config.vault.equals(vaultedToken));
                assert.ok(config.mint.equals(mintedToken));
                assert.equal(config.freezeAdministrators.length, 1);
                assert.ok(config.freezeAdministrators[0].equals(freezeAdmin.publicKey));
                assert.equal(config.rewardsAdministrators.length, 1);
                assert.ok(config.rewardsAdministrators[0].equals(rewardsAdmin.publicKey));
                assert.equal(config.unbondingPeriod.toNumber(), 0, "unbondingPeriod deprecated field should be 0");
                assert.ok(!config.paused);
                return;
            }

            await program.methods
                .initialize([freezeAdmin.publicKey], [rewardsAdmin.publicKey])
                .accountsStrict({
                    stakeConfig: stakeConfigPda,
                    vaultAuthority: vaultAuthorityPda,
                    vaultTokenAccount: vaultTokenAccount,
                    stakeVaultTokenAccountConfig: stakeVaultTokenAccountConfigPda,
                    vaultTokenMint: vaultedToken,
                    mint: mintedToken,
                    signer: provider.wallet.publicKey,
                    tokenProgram: TOKEN_PROGRAM_ID,
                    systemProgram: SystemProgram.programId,
                    programData: programDataPda,
                })
                .rpc();

            const config = await program.account.stakeConfig.fetch(stakeConfigPda);
            assert.ok(config.vault.equals(vaultedToken));
            assert.ok(config.mint.equals(mintedToken));
            assert.equal(config.freezeAdministrators.length, 1);
            assert.ok(config.freezeAdministrators[0].equals(freezeAdmin.publicKey));
            assert.equal(config.rewardsAdministrators.length, 1);
            assert.ok(config.rewardsAdministrators[0].equals(rewardsAdmin.publicKey));
            assert.equal(config.unbondingPeriod.toNumber(), 0, "unbondingPeriod deprecated field should be 0");
            assert.ok(!config.paused);
        });

        it("initializes price config", async () => {
            const existing = await provider.connection.getAccountInfo(stakePriceConfigPda);
            if (existing) {
                const priceConfig = await program.account.stakePriceConfig.fetch(stakePriceConfigPda);
                assert.equal(priceConfig.priceScale.toString(), TEST_PRICE_SCALE.toString());
                assert.equal(priceConfig.priceMaxStaleness.toString(), "3600");
                return;
            }

            // Price convention: price = (wYLDS per 1 AUTO) * price_scale
            // At TEST_PRICE_SCALE = 1e9 and TEST_PRICE_1TO1 = 1e9 → 1:1 exchange rate
            // price_max_staleness = 3600 seconds (1 hour)
            await program.methods
                .initializePriceConfig(
                    PublicKey.default, // chainlink_program (placeholder for localnet)
                    PublicKey.default, // chainlink_verifier_account
                    PublicKey.default, // chainlink_access_controller
                    TEST_FEED_ID,
                    TEST_PRICE_SCALE,
                    new BN(3600)
                )
                .accountsStrict({
                    stakeConfig: stakeConfigPda,
                    stakePriceConfig: stakePriceConfigPda,
                    signer: provider.wallet.publicKey,
                    programData: programDataPda,
                    systemProgram: SystemProgram.programId,
                })
                .rpc();

            const priceConfig = await program.account.stakePriceConfig.fetch(stakePriceConfigPda);
            assert.equal(priceConfig.priceScale.toString(), TEST_PRICE_SCALE.toString());
            assert.equal(priceConfig.priceMaxStaleness.toString(), "3600");
            assert.equal(priceConfig.priceTimestamp.toString(), "0", "price not set until verify_price is called");
        });

        it("reward config uses 0.75% default once the account exists", async () => {
            const existing = await provider.connection.getAccountInfo(stakeRewardConfigPda);
            if (!existing) {
                // Created lazily on first publish_rewards (init_if_needed).
                return;
            }
            const rewardConfig = await program.account.stakeRewardConfig.fetch(stakeRewardConfigPda);
            assert.equal(rewardConfig.maxRewardBps.toNumber(), 75, "maxRewardBps should be 75 (0.75%)");
        });

        it("set initial price for testing via set_price_for_testing", async () => {
            const priceConfigBefore = await program.account.stakePriceConfig.fetch(stakePriceConfigPda);
            if (
                priceConfigBefore.price.toString() === TEST_PRICE_1TO1.toString() &&
                priceConfigBefore.priceTimestamp.toNumber() > 0
            ) {
                return;
            }

            // Sets a 1:1 price with a fresh timestamp so deposit/redeem tests can proceed.
            // In production this would be replaced by a call to verify_price with a Chainlink report.
            await setPriceForTesting(TEST_PRICE_1TO1);

            const priceConfig = await program.account.stakePriceConfig.fetch(stakePriceConfigPda);
            assert.ok(priceConfig.price.toString() === TEST_PRICE_1TO1.toString(), "price should be set");
            assert.ok(priceConfig.priceTimestamp.toNumber() > 0, "price_timestamp should be set");
        });

        it("fails when called twice", async () => {
            try {
                await program.methods
                    .initialize([freezeAdmin.publicKey], [rewardsAdmin.publicKey])
                    .accounts({
                        signer: provider.wallet.publicKey,
                        vaultTokenAccount: vaultTokenAccount,
                        vaultTokenMint: vaultedToken,
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

    describe("price config", () => {
        it("fails deposit when price is stale", async () => {
            // Backdate price_timestamp by more than price_max_staleness (3600s)
            await setPriceForTesting(TEST_PRICE_1TO1, 3700);

            try {
                await program.methods
                    .deposit(new BN(1_000_000))
                    .accountsStrict({
                        stakeConfig: stakeConfigPda,
                        vaultTokenAccount: vaultTokenAccount,
                        stakeVaultTokenAccountConfig: stakeVaultTokenAccountConfigPda,
                        vaultAuthority: vaultAuthorityPda,
                        mint: mintedToken,
                        vaultMint: vaultedToken,
                        mintAuthority: mintAuthorityPda,
                        signer: user.publicKey,
                        userVaultTokenAccount: userVaultTokenAccount,
                        userMintTokenAccount: userMintTokenAccount,
                        stakePriceConfig: stakePriceConfigPda,
                        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID
                    })
                    .signers([user])
                    .rpc();
                assert.fail("Should have thrown PriceTooStale");
            } catch (err) {
                expect(err).to.exist;
                expect(err.toString()).to.include("PriceTooStale");
            }
        });

        it("fails redeem when price is stale", async () => {
            // price_timestamp is already stale from previous test
            try {
                await program.methods.redeem(new BN(1000))
                    .accountsStrict({
                        stakeConfig: stakeConfigPda,
                        vaultTokenAccount: vaultTokenAccount,
                        stakeVaultTokenAccountConfig: stakeVaultTokenAccountConfigPda,
                        vaultAuthority: vaultAuthorityPda,
                        signer: user.publicKey,
                        ticket: program.programId,
                        userVaultTokenAccount: userVaultTokenAccount,
                        userMintTokenAccount: userMintTokenAccount,
                        mint: mintedToken,
                        vaultMint: vaultedToken,
                        stakePriceConfig: stakePriceConfigPda,
                        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
                    })
                    .signers([user])
                    .rpc();
                assert.fail("Should have thrown PriceTooStale");
            } catch (err) {
                expect(err).to.exist;
                expect(err.toString()).to.include("PriceTooStale");
            }
        });

        it("refreshes price and allows deposit again", async () => {
            // Restore fresh price so subsequent deposit/redeem tests can pass
            await setPriceForTesting(TEST_PRICE_1TO1);
        });

        it("updates price config parameters", async () => {
            await program.methods
                .updatePriceConfig(
                    PublicKey.default,
                    PublicKey.default,
                    PublicKey.default,
                    TEST_FEED_ID,
                    TEST_PRICE_SCALE,
                    new BN(7200) // update staleness to 2 hours
                )
                .accountsStrict({
                    stakeConfig: stakeConfigPda,
                    stakePriceConfig: stakePriceConfigPda,
                    signer: provider.wallet.publicKey,
                    programData: programDataPda,
                })
                .rpc();

            const priceConfig = await program.account.stakePriceConfig.fetch(stakePriceConfigPda);
            assert.equal(priceConfig.priceMaxStaleness.toString(), "7200");
            // price and price_timestamp should NOT be reset by update_price_config
            assert.ok(priceConfig.price.toString() === TEST_PRICE_1TO1.toString(), "price unchanged");
            assert.ok(priceConfig.priceTimestamp.toNumber() > 0, "price_timestamp unchanged");

            // Restore staleness to 3600 for remaining tests
            await program.methods
                .updatePriceConfig(
                    PublicKey.default,
                    PublicKey.default,
                    PublicKey.default,
                    TEST_FEED_ID,
                    TEST_PRICE_SCALE,
                    new BN(3600)
                )
                .accountsStrict({
                    stakeConfig: stakeConfigPda,
                    stakePriceConfig: stakePriceConfigPda,
                    signer: provider.wallet.publicKey,
                    programData: programDataPda,
                })
                .rpc();
        });
    });

    describe("deposit", () => {
        it("deposits at Chainlink price (1:1) and redeems correctly", async () => {
            /*
            With Chainlink price oracle, shares = deposit * price_scale / price.
            At TEST_PRICE_1TO1 = TEST_PRICE_SCALE (1e9), this simplifies to a 1:1 ratio.
            Unlike the old ratio-based model, the exchange rate is determined by the Chainlink
            feed rather than vault balance — direct transfers to the vault do NOT affect shares.
            */

            const user1InitialVaultedBalance = (await getAccount(provider.connection, userVaultTokenAccount)).amount;

            // step 1 - deposit 1 token; expect to receive 1 token worth of AUTO (1:1 at current price)
            await program.methods
                .deposit(new BN(ONE_BIG_TOKEN))
                .accountsStrict({
                    stakeConfig: stakeConfigPda,
                    vaultTokenAccount: vaultTokenAccount,
                    stakeVaultTokenAccountConfig: stakeVaultTokenAccountConfigPda,
                    vaultAuthority: vaultAuthorityPda,
                    mint: mintedToken,
                    vaultMint: vaultedToken,
                    mintAuthority: mintAuthorityPda,
                    signer: user.publicKey,
                    userVaultTokenAccount: userVaultTokenAccount,
                    userMintTokenAccount: userMintTokenAccount,
                    stakePriceConfig: stakePriceConfigPda,
                    tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID
                })
                .signers([user])
                .rpc();

            const user1Shares = (await getAccount(provider.connection, userMintTokenAccount)).amount;
            // shares = amount * price_scale / price = ONE_BIG_TOKEN * 1e9 / 1e9 = ONE_BIG_TOKEN
            assert.equal(user1Shares, ONE_BIG_SHARE, "User 1 should receive exactly ONE_BIG_TOKEN AUTO at 1:1 price");

            // step 2 - transfer tokens directly to vault; price is Chainlink-sourced so this does NOT affect share calc
            await transfer(provider.connection, user, userVaultTokenAccount, vaultTokenAccount, user.publicKey, ONE_BIG_TOKEN * createBigInt(10_000));

            // step 3 - user 2 deposits 10,000 tokens; with Chainlink price (not vault ratio) they get 10,000 AUTO
            await program.methods
                .deposit(new BN(ONE_BIG_TOKEN * createBigInt(10_000)))
                .accountsStrict({
                    stakeConfig: stakeConfigPda,
                    vaultTokenAccount: vaultTokenAccount,
                    stakeVaultTokenAccountConfig: stakeVaultTokenAccountConfigPda,
                    vaultAuthority: vaultAuthorityPda,
                    mint: mintedToken,
                    vaultMint: vaultedToken,
                    mintAuthority: mintAuthorityPda,
                    signer: user2.publicKey,
                    userVaultTokenAccount: user2VaultTokenAccount,
                    userMintTokenAccount: user2MintTokenAccount,
                    stakePriceConfig: stakePriceConfigPda,
                    tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID
                })
                .signers([user2])
                .rpc();

            const user2Shares = (await getAccount(provider.connection, user2MintTokenAccount)).amount;
            // shares = 10_000 * ONE_BIG_TOKEN * 1e9 / 1e9 = 10_000 * ONE_BIG_TOKEN
            assert.equal(user2Shares, ONE_BIG_SHARE * createBigInt(10_000), "User 2 should receive 10,000 AUTO at 1:1 price");

            // step 4 - user 1 redeems; expects to receive 1 wYLDS per AUTO (1:1 price)
            await program.methods.redeem(new BN(user1Shares.toString()))
                .accountsStrict({
                    stakeConfig: stakeConfigPda,
                    vaultTokenAccount: vaultTokenAccount,
                    stakeVaultTokenAccountConfig: stakeVaultTokenAccountConfigPda,
                    vaultAuthority: vaultAuthorityPda,
                    signer: user.publicKey,
                    ticket: program.programId,
                    userVaultTokenAccount: userVaultTokenAccount,
                    userMintTokenAccount: userMintTokenAccount,
                    mint: mintedToken,
                    vaultMint: vaultedToken,
                    stakePriceConfig: stakePriceConfigPda,
                    tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
                }).signers([user])
                .rpc();

            const userVaultBalanceAfter = (await getAccount(provider.connection, userVaultTokenAccount)).amount;
            // wYLDS = shares * price / price_scale = user1Shares * 1e9 / 1e9 = user1Shares = ONE_BIG_TOKEN
            // original balance - 1 deposited - 10,000 transferred + 1 redeemed
            assert.equal(
                userVaultBalanceAfter,
                user1InitialVaultedBalance - ONE_BIG_TOKEN - (ONE_BIG_TOKEN * createBigInt(10_000)) + ONE_BIG_SHARE,
                "User 1 should recover exactly 1 wYLDS (1:1 price redeem)"
            );
        });

        it("user 2 redeems", async () => {
            const vaultBalanceBefore = (await getAccount(provider.connection, vaultTokenAccount)).amount;
            const user2MintTokenBefore = (await getAccount(provider.connection, user2MintTokenAccount)).amount;
            const user2VaultBalanceBefore = (await getAccount(provider.connection, user2VaultTokenAccount)).amount;

            // With Chainlink 1:1 price, user 2 has ONE_BIG_SHARE * 10_000 AUTO from the previous test
            assert.equal(user2MintTokenBefore, ONE_BIG_SHARE * createBigInt(10_000), "User 2 should have 10,000 AUTO");
            assert.equal(user2VaultBalanceBefore, BIG_ZERO, "User 2 should not have any vault tokens");

            await program.methods.redeem(new BN(user2MintTokenBefore.toString()))
                .accountsStrict({
                    stakeConfig: stakeConfigPda,
                    vaultTokenAccount: vaultTokenAccount,
                    stakeVaultTokenAccountConfig: stakeVaultTokenAccountConfigPda,
                    vaultAuthority: vaultAuthorityPda,
                    signer: user2.publicKey,
                    ticket: program.programId, // no legacy ticket
                    userVaultTokenAccount: user2VaultTokenAccount,
                    userMintTokenAccount: user2MintTokenAccount,
                    mint: mintedToken,
                    vaultMint: vaultedToken,
                    stakePriceConfig: stakePriceConfigPda,
                    tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
                }).signers([user2])
                .rpc();

            const vaultBalanceAfter = (await getAccount(provider.connection, vaultTokenAccount)).amount;
            const user2MintTokenAfter = (await getAccount(provider.connection, user2MintTokenAccount)).amount;
            const user2VaultBalanceAfter = (await getAccount(provider.connection, user2VaultTokenAccount)).amount;

            // At 1:1 price: wYLDS_returned = shares * price / price_scale = shares (1:1)
            assert.equal(user2VaultBalanceAfter, user2MintTokenBefore, "User 2 should receive exactly their share count in wYLDS at 1:1 price");
            assert.equal(vaultBalanceAfter, vaultBalanceBefore - user2VaultBalanceAfter, "Vault balance should reflect all redeems");
            assert.equal(user2MintTokenAfter, BIG_ZERO, "User should not have staked tokens after redeem");
        });

        it("handles multiple deposits correctly", async () => {
            const firstDeposit = createBigInt(50_000_000);
            const secondDeposit = createBigInt(25_000_000);

            await program.methods
                .deposit(new BN(firstDeposit))
                .accountsStrict({
                    stakeConfig: stakeConfigPda,
                    vaultTokenAccount: vaultTokenAccount,
                    stakeVaultTokenAccountConfig: stakeVaultTokenAccountConfigPda,
                    vaultAuthority: vaultAuthorityPda,
                    mint: mintedToken,
                    vaultMint: vaultedToken,
                    mintAuthority: mintAuthorityPda,
                    signer: user.publicKey,
                    userVaultTokenAccount: userVaultTokenAccount,
                    userMintTokenAccount: userMintTokenAccount,
                    stakePriceConfig: stakePriceConfigPda,
                    tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID
                })
                .signers([user])
                .rpc();

            const sharesAfterFirst = (await getAccount(provider.connection, userMintTokenAccount)).amount;

            await program.methods
                .deposit(new BN(secondDeposit))
                .accountsStrict({
                    stakeConfig: stakeConfigPda,
                    vaultTokenAccount: vaultTokenAccount,
                    stakeVaultTokenAccountConfig: stakeVaultTokenAccountConfigPda,
                    vaultAuthority: vaultAuthorityPda,
                    mint: mintedToken,
                    vaultMint: vaultedToken,
                    mintAuthority: mintAuthorityPda,
                    signer: user.publicKey,
                    userVaultTokenAccount: userVaultTokenAccount,
                    userMintTokenAccount: userMintTokenAccount,
                    stakePriceConfig: stakePriceConfigPda,
                    tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID
                })
                .signers([user])
                .rpc();

            const sharesAfterSecond = (await getAccount(provider.connection, userMintTokenAccount)).amount;

            assert.ok(sharesAfterSecond > sharesAfterFirst, "Shares after second deposit should be greater than after first");
        });

        it("fails with zero deposit", async () => {
            try {
                await program.methods
                    .deposit(new BN(0))
                    .accountsStrict({
                        stakeConfig: stakeConfigPda,
                        vaultTokenAccount: vaultTokenAccount,
                        stakeVaultTokenAccountConfig: stakeVaultTokenAccountConfigPda,
                        vaultAuthority: vaultAuthorityPda,
                        mint: mintedToken,
                        vaultMint: vaultedToken,
                        mintAuthority: mintAuthorityPda,
                        signer: user.publicKey,
                        userVaultTokenAccount: userVaultTokenAccount,
                        userMintTokenAccount: userMintTokenAccount,
                        stakePriceConfig: stakePriceConfigPda,
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
                        stakeConfig: stakeConfigPda,
                        vaultTokenAccount: vaultTokenAccount,
                        stakeVaultTokenAccountConfig: stakeVaultTokenAccountConfigPda,
                        vaultAuthority: vaultAuthorityPda,
                        mint: mintedToken,
                        vaultMint: vaultedToken,
                        mintAuthority: mintAuthorityPda,
                        signer: user.publicKey,
                        userVaultTokenAccount: userVaultTokenAccount,
                        userMintTokenAccount: userMintTokenAccount,
                        stakePriceConfig: stakePriceConfigPda,
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
                provider.wallet.payer,
                vaultedToken,
                vaultAuthorityPda,
                badTokenKeypair
            );

            try {
                await program.methods
                    .deposit(new BN(1))
                    .accountsStrict({
                        stakeConfig: stakeConfigPda,
                        vaultTokenAccount: badVaultTokenAccount,
                        stakeVaultTokenAccountConfig: stakeVaultTokenAccountConfigPda,
                        vaultAuthority: vaultAuthorityPda,
                        mint: mintedToken,
                        vaultMint: vaultedToken,
                        mintAuthority: mintAuthorityPda,
                        signer: user.publicKey,
                        userVaultTokenAccount: userVaultTokenAccount,
                        userMintTokenAccount: userMintTokenAccount,
                        stakePriceConfig: stakePriceConfigPda,
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
        it("redeems a partial amount immediately (no waiting)", async () => {
            const redeemAmount = new BN(1000);
            const mintBalanceBefore = (await getAccount(provider.connection, userMintTokenAccount)).amount;
            const vaultBalanceBefore = (await getAccount(provider.connection, vaultTokenAccount)).amount;
            const userVaultBalanceBefore = (await getAccount(provider.connection, userVaultTokenAccount)).amount;

            assert.ok(mintBalanceBefore >= BigInt(redeemAmount.toNumber()), "User must have enough AUTO to redeem");

            await program.methods.redeem(redeemAmount)
                .accountsStrict({
                    stakeConfig: stakeConfigPda,
                    vaultTokenAccount: vaultTokenAccount,
                    stakeVaultTokenAccountConfig: stakeVaultTokenAccountConfigPda,
                    vaultAuthority: vaultAuthorityPda,
                    signer: user.publicKey,
                    ticket: program.programId, // no legacy ticket
                    userVaultTokenAccount: userVaultTokenAccount,
                    userMintTokenAccount: userMintTokenAccount,
                    stakePriceConfig: stakePriceConfigPda,
                    mint: mintedToken,
                    vaultMint: vaultedToken,
                    tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
                })
                .signers([user])
                .rpc();

            const mintBalanceAfter = (await getAccount(provider.connection, userMintTokenAccount)).amount;
            const vaultBalanceAfter = (await getAccount(provider.connection, vaultTokenAccount)).amount;
            const userVaultBalanceAfter = (await getAccount(provider.connection, userVaultTokenAccount)).amount;

            assert.equal(mintBalanceAfter, mintBalanceBefore - BigInt(redeemAmount.toNumber()), "AUTO should be burned");
            assert.ok(vaultBalanceAfter < vaultBalanceBefore, "Vault balance should decrease");
            assert.ok(userVaultBalanceAfter > userVaultBalanceBefore, "User should receive wYLDS");
        });

        it("fails with zero amount", async () => {
            try {
                await program.methods.redeem(new BN(0))
                    .accountsStrict({
                        stakeConfig: stakeConfigPda,
                        vaultTokenAccount: vaultTokenAccount,
                        stakeVaultTokenAccountConfig: stakeVaultTokenAccountConfigPda,
                        vaultAuthority: vaultAuthorityPda,
                        signer: user.publicKey,
                        ticket: program.programId,
                        userVaultTokenAccount: userVaultTokenAccount,
                        userMintTokenAccount: userMintTokenAccount,
                        stakePriceConfig: stakePriceConfigPda,
                        mint: mintedToken,
                        vaultMint: vaultedToken,
                        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
                    })
                    .signers([user])
                    .rpc();
                assert.fail("Should have thrown error");
            } catch (err) {
                expect(err).to.exist;
                expect(err.toString()).to.include("InvalidAmount");
            }
        });

        it("fails with more than user balance", async () => {
            const mintBalance = (await getAccount(provider.connection, userMintTokenAccount)).amount;
            const tooMuch = new BN(mintBalance.toString()).add(new BN(1));

            try {
                await program.methods.redeem(tooMuch)
                    .accountsStrict({
                        stakeConfig: stakeConfigPda,
                        vaultTokenAccount: vaultTokenAccount,
                        stakeVaultTokenAccountConfig: stakeVaultTokenAccountConfigPda,
                        vaultAuthority: vaultAuthorityPda,
                        signer: user.publicKey,
                        ticket: program.programId,
                        userVaultTokenAccount: userVaultTokenAccount,
                        userMintTokenAccount: userMintTokenAccount,
                        stakePriceConfig: stakePriceConfigPda,
                        mint: mintedToken,
                        vaultMint: vaultedToken,
                        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
                    })
                    .signers([user])
                    .rpc();
                assert.fail("Should have thrown error");
            } catch (err) {
                expect(err).to.exist;
                expect(err.toString()).to.include("InsufficientBalance");
            }
        });

        it("redeems full balance in one call", async () => {
            const mintBalance = (await getAccount(provider.connection, userMintTokenAccount)).amount;
            if (mintBalance === BigInt(0)) {
                assert.fail("Test precondition violated: expected non-zero mint balance before redeeming full balance");
            }

            await program.methods.redeem(new BN(mintBalance.toString()))
                .accountsStrict({
                    stakeConfig: stakeConfigPda,
                    vaultTokenAccount: vaultTokenAccount,
                    stakeVaultTokenAccountConfig: stakeVaultTokenAccountConfigPda,
                    vaultAuthority: vaultAuthorityPda,
                    signer: user.publicKey,
                    ticket: program.programId,
                    userVaultTokenAccount: userVaultTokenAccount,
                    userMintTokenAccount: userMintTokenAccount,
                    stakePriceConfig: stakePriceConfigPda,
                    mint: mintedToken,
                    vaultMint: vaultedToken,
                    tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
                })
                .signers([user])
                .rpc();

            const mintBalanceAfter = (await getAccount(provider.connection, userMintTokenAccount)).amount;
            assert.equal(mintBalanceAfter, BigInt(0), "All AUTO should be burned");
        });
    });

    describe("paused protocol", () => {
        // vault-mint.test.ts runs first (lexical order) and calls AUTO publish_rewards, which sets
        // last_reward_distributed_at on this pool. Clear cooldown before any publish_rewards here so
        // we hit vault-mint's ProtocolPaused (not RewardCooldownNotElapsed) in the mint-paused test.
        beforeEach(async () => {
            await ensureShortRewardCooldownForTests();
        });

        it("pauses all functionality", async () => {
            await program.methods
                .pause(true)
                .accountsStrict({
                    stakeConfig: stakeConfigPda,
                    signer: freezeAdmin.publicKey,
                })
                .signers([freezeAdmin])
                .rpc();

            const config = await program.account.stakeConfig.fetch(stakeConfigPda);
            assert.isTrue(config.paused);
        });

        it("fails pause when called by non admin", async () => {
            try {
                await program.methods
                    .pause(true)
                    .accountsStrict({
                        stakeConfig: stakeConfigPda,
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
                        stakeConfig: stakeConfigPda,
                        vaultTokenAccount: vaultTokenAccount,
                        stakeVaultTokenAccountConfig: stakeVaultTokenAccountConfigPda,
                        vaultAuthority: vaultAuthorityPda,
                        mint: mintedToken,
                        vaultMint: vaultedToken,
                        mintAuthority: mintAuthorityPda,
                        signer: user.publicKey,
                        userVaultTokenAccount: userVaultTokenAccount,
                        userMintTokenAccount: userMintTokenAccount,
                        stakePriceConfig: stakePriceConfigPda,
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
        it("prevents redeem when paused", async () => {
            // First deposit some tokens so user has shares to redeem
            const userMintBalance = (await getAccount(provider.connection, userMintTokenAccount)).amount;
            if (userMintBalance === BigInt(0)) {
                // Make a small deposit to give user shares for the redeem attempt
                const userVaultBalance = (await getAccount(provider.connection, userVaultTokenAccount)).amount;
                if (userVaultBalance > BigInt(0)) {
                    await program.methods
                        .pause(false) // temporarily unpause to deposit
                        .accountsStrict({ stakeConfig: stakeConfigPda, signer: freezeAdmin.publicKey })
                        .signers([freezeAdmin])
                        .rpc();
                    await program.methods
                        .deposit(new BN(10_000_000))
                        .accountsStrict({
                            stakeConfig: stakeConfigPda,
                            vaultTokenAccount: vaultTokenAccount,
                            stakeVaultTokenAccountConfig: stakeVaultTokenAccountConfigPda,
                            vaultAuthority: vaultAuthorityPda,
                            mint: mintedToken,
                            vaultMint: vaultedToken,
                            mintAuthority: mintAuthorityPda,
                            signer: user.publicKey,
                            userVaultTokenAccount: userVaultTokenAccount,
                            userMintTokenAccount: userMintTokenAccount,
                            stakePriceConfig: stakePriceConfigPda,
                            tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID
                        })
                        .signers([user])
                        .rpc();
                    await program.methods
                        .pause(true) // re-pause
                        .accountsStrict({ stakeConfig: stakeConfigPda, signer: freezeAdmin.publicKey })
                        .signers([freezeAdmin])
                        .rpc();
                }
            }

            try {
                await program.methods.redeem(new BN(1000))
                    .accountsStrict({
                        stakeConfig: stakeConfigPda,
                        vaultTokenAccount: vaultTokenAccount,
                        stakeVaultTokenAccountConfig: stakeVaultTokenAccountConfigPda,
                        vaultAuthority: vaultAuthorityPda,
                        signer: user.publicKey,
                        ticket: program.programId,
                        userVaultTokenAccount: userVaultTokenAccount,
                        userMintTokenAccount: userMintTokenAccount,
                        stakePriceConfig: stakePriceConfigPda,
                        mint: mintedToken,
                        vaultMint: vaultedToken,
                        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
                    })
                    .signers([user])
                    .rpc();
                assert.fail("Should have thrown error");
            } catch (err) {
                expect(err).to.exist;
                expect(err.toString()).to.include("ProtocolPaused");
            }
        });

        it("unpauses", async () => {
            await program.methods
                .pause(false)
                .accountsStrict({
                    stakeConfig: stakeConfigPda,
                    signer: freezeAdmin.publicKey,
                })
                .signers([freezeAdmin])
                .rpc();
            const config = await program.account.stakeConfig.fetch(stakeConfigPda);
            assert.ok(!config.paused);
        });

        it("pause mint program", async () => {
            await mintProgram.methods
                .pause(true)
                .accountsStrict({
                    config: configPda,
                    signer: freezeAdmin.publicKey,
                })
                .signers([freezeAdmin])
                .rpc();

            const config = await mintProgram.account.config.fetch(configPda);
            assert.isTrue(config.paused);
        });

        it("prevents publish rewards redeem when MINT PROGRAM is paused", async () => {
            try {
                // Use 0.5% of vault balance — within the 0.75% cap so the cap isn't hit before ProtocolPaused
                const vaultBalance = (await getAccount(provider.connection, vaultTokenAccount)).amount;
                const amount = (vaultBalance * BigInt(50)) / BigInt(10_000);
                const [rewardsRecordPda] = anchor.web3.PublicKey.findProgramAddressSync(
                    [
                        Buffer.from("reward_record"),
                        Buffer.from(new Uint32Array([++publishRewardsId]).buffer),
                        Buffer.from(new BigUint64Array([amount]).buffer)
                    ],
                    program.programId);

                await program.methods
                    .publishRewards(publishRewardsId, new BN(amount.toString()))
                    .accountsStrict({
                        stakeConfig: stakeConfigPda,
                        stakeVaultTokenAccountConfig: stakeVaultTokenAccountConfigPda,
                        mintConfig: configPda,
                        externalMintAuthority: externalMintAuthorityPda,
                        mintProgram: mintProgram.programId,
                        thisProgram: program.programId,
                        vaultMintAllowedExternalPrograms: allowedExternalMintProgramsPda,
                        admin: rewardsAdmin.publicKey,
                        rewardsMint: vaultedToken,
                        rewardsMintAuthority: rewardsMintAuthorityPda,
                        vaultTokenAccount: vaultTokenAccount,
                        vaultAuthority: vaultAuthorityPda,
                        mint: mintedToken,
                        rewardRecord: rewardsRecordPda,
                        stakeRewardConfig: stakeRewardConfigPda,
                        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
                        systemProgram: anchor.web3.SystemProgram.programId,
                    })
                    .signers([rewardsAdmin])
                    .rpc();

                assert.fail("Should have thrown error");
            } catch (err) {
                expect(err).to.exist;
                // Fails in vault-mint::external_program_mint (CPI); on-chain msg is "Protocol is paused".
                const msg = String(err);
                expect(
                    msg.includes("ProtocolPaused") || msg.includes("Protocol is paused"),
                    msg
                ).to.be.true;
            }
        });


        it("unpause mint program", async () => {
            await mintProgram.methods
                .pause(false)
                .accountsStrict({
                    config: configPda,
                    signer: freezeAdmin.publicKey,
                })
                .signers([freezeAdmin])
                .rpc();

            const config = await mintProgram.account.config.fetch(configPda);
            assert.isFalse(config.paused);
        });

    });

    describe("freeze thaw", () => {
        it("freezes user mint token account", async () => {
            await program.methods
                .freezeTokenAccount()
                .accountsStrict({
                    stakeConfig: stakeConfigPda,
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
                    stakeConfig: stakeConfigPda,
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
                        stakeConfig: stakeConfigPda,
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
                        stakeConfig: stakeConfigPda,
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
                    stakeConfig: stakeConfigPda,
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
                        stakeConfig: stakeConfigPda,
                        vaultTokenAccount: vaultTokenAccount,
                        stakeVaultTokenAccountConfig: stakeVaultTokenAccountConfigPda,
                        vaultAuthority: vaultAuthorityPda,
                        mint: mintedToken,
                        vaultMint: vaultedToken,
                        mintAuthority: mintAuthorityPda,
                        signer: user.publicKey,
                        userVaultTokenAccount: userVaultTokenAccount,
                        userMintTokenAccount: userMintTokenAccount,
                        stakePriceConfig: stakePriceConfigPda,
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
                    stakeConfig: stakeConfigPda,
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

    //write test cases against the rewards merkle tree functionality
    describe("rewards", () => {
        beforeEach(async () => {
            await ensureShortRewardCooldownForTests();
        });

        after(async () => {
            vaultSummary("after rewards");
            const info = await provider.connection.getAccountInfo(stakeRewardConfigPda);
            if (info) {
                await program.methods
                    .updateRewardPeriodSeconds(STAKE_REWARD_CONFIG_DEFAULTS.rewardPeriodSeconds)
                    .accountsStrict(stakeRewardConfigUpgradeAuthorityAccounts())
                    .rpc();
            }
        });

        it("publish rewards", async () => {

            const rateBefore = await exchangeRate();
            const vaultBalanceBefore = (await getAccount(provider.connection, vaultTokenAccount)).amount;

            // Use 0.5% of vault balance to stay within the 0.75% reward cap
            const amount = (vaultBalanceBefore * BigInt(50)) / BigInt(10_000);
            const [rewardsRecordPda] = anchor.web3.PublicKey.findProgramAddressSync(
                [
                    Buffer.from("reward_record"),
                    Buffer.from(new Uint32Array([++publishRewardsId]).buffer),
                    Buffer.from(new BigUint64Array([amount]).buffer)
                ],
                program.programId);

            const sig = await program.methods
                .publishRewards(publishRewardsId, new BN(amount.toString()))
                .accountsStrict({
                    stakeConfig: stakeConfigPda,
                    stakeVaultTokenAccountConfig: stakeVaultTokenAccountConfigPda,
                    mintConfig: configPda,
                    externalMintAuthority: externalMintAuthorityPda,
                    mintProgram: mintProgram.programId,
                    thisProgram: program.programId,
                    vaultMintAllowedExternalPrograms: allowedExternalMintProgramsPda,
                    admin: rewardsAdmin.publicKey,
                    rewardsMint: vaultedToken,
                    rewardsMintAuthority: rewardsMintAuthorityPda,
                    vaultTokenAccount: vaultTokenAccount,
                    vaultAuthority: vaultAuthorityPda,
                    mint: mintedToken,
                    rewardRecord: rewardsRecordPda,
                    stakeRewardConfig: stakeRewardConfigPda,
                    
                    tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
                    systemProgram: anchor.web3.SystemProgram.programId,
                })
                .signers([rewardsAdmin])
                .rpc({ commitment: "confirmed", skipPreflight: true });

            // Regression test: RewardsPublished event total_assets must reflect the post-CPI
            // vault balance (after reload()), not the stale pre-CPI cached value.
            const vaultBalanceAfter = (await getAccount(provider.connection, vaultTokenAccount)).amount;
            const expectedTotalAssets = vaultBalanceBefore + amount;
            assert.equal(vaultBalanceAfter, expectedTotalAssets, "Vault balance should increase by reward amount");

            const events = await parseEvents(sig);
            const event = events.find(e => e.name === "rewardsPublished");

            assert.isDefined(event, "RewardsPublished event should be emitted");
            assert.equal(
                (event.data.totalAssets as BN).toString(),
                expectedTotalAssets.toString(),
                "RewardsPublished event total_assets must equal post-CPI vault balance, not pre-CPI stale value"
            );
            assert.equal(
                (event.data.amount as BN).toString(),
                amount.toString(),
                "RewardsPublished event amount should match published reward"
            );
        });

        it("prevents duplicate publish rewards", async () => {

            const amount = 100_000_000_000;
            const [rewardsRecordPda] = anchor.web3.PublicKey.findProgramAddressSync(
                [
                    Buffer.from("reward_record"),
                    Buffer.from(new Uint32Array([publishRewardsId]).buffer),
                    Buffer.from(new BigUint64Array([createBigInt(amount)]).buffer)
                ],
                program.programId);

            try {
                await program.methods
                    .publishRewards(publishRewardsId, new BN(amount))
                    .accountsStrict({
                        stakeConfig: stakeConfigPda,
                        stakeVaultTokenAccountConfig: stakeVaultTokenAccountConfigPda,
                        mintConfig: configPda,
                        externalMintAuthority: externalMintAuthorityPda,
                        mintProgram: mintProgram.programId,
                        thisProgram: program.programId,
                        vaultMintAllowedExternalPrograms: allowedExternalMintProgramsPda,
                        admin: rewardsAdmin.publicKey,
                        rewardsMint: vaultedToken,
                        rewardsMintAuthority: rewardsMintAuthorityPda,
                        vaultTokenAccount: vaultTokenAccount,
                        vaultAuthority: vaultAuthorityPda,
                        mint: mintedToken,
                        rewardRecord: rewardsRecordPda,
                        stakeRewardConfig: stakeRewardConfigPda,
                        
                        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
                        systemProgram: anchor.web3.SystemProgram.programId,
                    })
                    .signers([rewardsAdmin])
                    .rpc();
                assert.fail("Should have thrown error");
            } catch (e) {
                expect(e).to.exist;
            }
        });

        it("publish reward multiples", async () => {
            // Use 0.5% of vault balance — safely within the 0.75% cap for each call
            const vaultBalance = (await getAccount(provider.connection, vaultTokenAccount)).amount;
            const amount = (vaultBalance * BigInt(50)) / BigInt(10_000);
            const [rewardsRecordPda1] = anchor.web3.PublicKey.findProgramAddressSync(
                [
                    Buffer.from("reward_record"),
                    Buffer.from(new Uint32Array([++publishRewardsId]).buffer),
                    Buffer.from(new BigUint64Array([amount]).buffer)
                ],
                program.programId);

            await program.methods
                .publishRewards(publishRewardsId, new BN(amount))
                .accountsStrict({
                    stakeConfig: stakeConfigPda,
                    stakeVaultTokenAccountConfig: stakeVaultTokenAccountConfigPda,
                    mintConfig: configPda,
                    externalMintAuthority: externalMintAuthorityPda,
                    mintProgram: mintProgram.programId,
                    thisProgram: program.programId,
                    vaultMintAllowedExternalPrograms: allowedExternalMintProgramsPda,
                    admin: rewardsAdmin.publicKey,
                    rewardsMint: vaultedToken,
                    rewardsMintAuthority: rewardsMintAuthorityPda,
                    vaultTokenAccount: vaultTokenAccount,
                    vaultAuthority: vaultAuthorityPda,
                    mint: mintedToken,
                    rewardRecord: rewardsRecordPda1,
                    stakeRewardConfig: stakeRewardConfigPda,
                    
                    tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
                    systemProgram: anchor.web3.SystemProgram.programId,
                })
                .signers([rewardsAdmin])
                .rpc();

            const [rewardsRecordPda2] = anchor.web3.PublicKey.findProgramAddressSync(
                [
                    Buffer.from("reward_record"),
                    Buffer.from(new Uint32Array([++publishRewardsId]).buffer),
                    Buffer.from(new BigUint64Array([amount]).buffer)
                ],
                program.programId);

            // Same test: second publish must clear reward_period_seconds cooldown (Clock is second-granular).
            await sleep(REWARD_COOLDOWN_TEST_SLEEP_MS);

            await program.methods
                .publishRewards(publishRewardsId, new BN(amount))
                .accountsStrict({
                    stakeConfig: stakeConfigPda,
                    stakeVaultTokenAccountConfig: stakeVaultTokenAccountConfigPda,
                    mintConfig: configPda,
                    externalMintAuthority: externalMintAuthorityPda,
                    mintProgram: mintProgram.programId,
                    thisProgram: program.programId,
                    vaultMintAllowedExternalPrograms: allowedExternalMintProgramsPda,
                    admin: rewardsAdmin.publicKey,
                    rewardsMint: vaultedToken,
                    rewardsMintAuthority: rewardsMintAuthorityPda,
                    vaultTokenAccount: vaultTokenAccount,
                    vaultAuthority: vaultAuthorityPda,
                    mint: mintedToken,
                    rewardRecord: rewardsRecordPda2,
                    stakeRewardConfig: stakeRewardConfigPda,
                    
                    tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
                    systemProgram: anchor.web3.SystemProgram.programId,
                })
                .signers([rewardsAdmin])
                .rpc();

            const reward1 = await program.account.rewardPublicationRecord.fetch(rewardsRecordPda1);
            const reward2 = await program.account.rewardPublicationRecord.fetch(rewardsRecordPda2);

            assert.equal(reward1.amount.toString(), amount.toString(), "First reward amount should match");
            assert.equal(reward2.amount.toString(), amount.toString(), "Second reward amount should match");
            assert.equal(reward2.id, publishRewardsId, "Second reward id should match current reward id");
        });

        it("only rewards admin can create rewards epoch", async () => {
            try {
                const amount = 100_000_000_000;
                const [rewardsRecordPda] = anchor.web3.PublicKey.findProgramAddressSync(
                    [
                        Buffer.from("reward_record"),
                        Buffer.from(new Uint32Array([++publishRewardsId]).buffer),
                        Buffer.from(new BigUint64Array([createBigInt(amount)]).buffer)
                    ],
                    program.programId);

                await program.methods
                    .publishRewards(publishRewardsId, new BN(amount))
                    .accountsStrict({
                        stakeConfig: stakeConfigPda,
                        stakeVaultTokenAccountConfig: stakeVaultTokenAccountConfigPda,
                        mintConfig: configPda,
                        externalMintAuthority: externalMintAuthorityPda,
                        mintProgram: mintProgram.programId,
                        thisProgram: program.programId,
                        vaultMintAllowedExternalPrograms: allowedExternalMintProgramsPda,
                        admin: user.publicKey,
                        rewardsMint: vaultedToken,
                        rewardsMintAuthority: rewardsMintAuthorityPda,
                        vaultTokenAccount: vaultTokenAccount,
                        vaultAuthority: vaultAuthorityPda,
                        mint: mintedToken,
                        rewardRecord: rewardsRecordPda,
                        stakeRewardConfig: stakeRewardConfigPda,
                        
                        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
                        systemProgram: anchor.web3.SystemProgram.programId,
                    })
                    .signers([user])
                    .rpc();
                assert.fail("Should have thrown error");
            } catch (err) {
                expect(err).to.exist;
            }
        });
    });

    describe("StakeRewardConfig", () => {
        beforeEach(async () => {
            await ensureShortRewardCooldownForTests();
        });

        // Helpers to build publishRewards accounts without duplicating boilerplate
        const publishRewardsAccounts = (rewardsRecordPda: PublicKey) => ({
            stakeConfig: stakeConfigPda,
            stakeVaultTokenAccountConfig: stakeVaultTokenAccountConfigPda,
            mintConfig: configPda,
            externalMintAuthority: externalMintAuthorityPda,
            mintProgram: mintProgram.programId,
            thisProgram: program.programId,
            vaultMintAllowedExternalPrograms: allowedExternalMintProgramsPda,
            admin: rewardsAdmin.publicKey,
            rewardsMint: vaultedToken,
            rewardsMintAuthority: rewardsMintAuthorityPda,
            vaultTokenAccount: vaultTokenAccount,
            vaultAuthority: vaultAuthorityPda,
            mint: mintedToken,
            rewardRecord: rewardsRecordPda,
            stakeRewardConfig: stakeRewardConfigPda,
            tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
            systemProgram: anchor.web3.SystemProgram.programId,
        });

        const makeRewardsRecordPda = (id: number, amount: bigint | number) => {
            const amountBigInt = typeof amount === "bigint" ? amount : BigInt(amount);
            return anchor.web3.PublicKey.findProgramAddressSync(
                [
                    Buffer.from("reward_record"),
                    Buffer.from(new Uint32Array([id]).buffer),
                    Buffer.from(new BigUint64Array([amountBigInt]).buffer),
                ],
                program.programId
            )[0];
        };

        const updateMaxRewardBpsAccounts = () => ({
            stakeConfig: stakeConfigPda,
            stakeRewardConfig: stakeRewardConfigPda,
            signer: provider.wallet.publicKey,
            programData: programDataPda,
        });

        const updateRewardConfigAccounts = (signer: PublicKey) => ({
            stakeConfig: stakeConfigPda,
            stakeRewardConfig: stakeRewardConfigPda,
            signer,
            programData: programDataPda,
            systemProgram: SystemProgram.programId,
        });

        // ── Account state verification ──────────────────────────────────────

        describe("account state verification", () => {
            it("lazy-init config has correct state: maxRewardBps = 75", async () => {
                const config = await program.account.stakeRewardConfig.fetch(stakeRewardConfigPda);
                assert.equal(config.maxRewardBps.toNumber(), 75, "maxRewardBps must be 75 (0.75%)");
            });

            it("publish_rewards does not mutate config state (init_if_needed is idempotent)", async () => {
                // Verify that calling publish_rewards (which uses init_if_needed) on an
                // already-initialized account does not change the stored bump or maxRewardBps.
                const configBefore = await program.account.stakeRewardConfig.fetch(stakeRewardConfigPda);
                const totalAssets = (await getAccount(provider.connection, vaultTokenAccount)).amount;
                const safeAmount = (totalAssets * BigInt(50)) / BigInt(10_000); // 0.5% — within 0.75% cap
                const rewardsRecordPda = makeRewardsRecordPda(++publishRewardsId, safeAmount);
                await program.methods
                    .publishRewards(publishRewardsId, new BN(safeAmount.toString()))
                    .accountsStrict(publishRewardsAccounts(rewardsRecordPda))
                    .signers([rewardsAdmin])
                    .rpc();
                const configAfter = await program.account.stakeRewardConfig.fetch(stakeRewardConfigPda);
                assert.equal(configAfter.bump, configBefore.bump, "bump must not change across publish_rewards calls");
                assert.equal(
                    configAfter.maxRewardBps.toString(),
                    configBefore.maxRewardBps.toString(),
                    "maxRewardBps must not change across publish_rewards calls"
                );
            });

            it("update_reward_config can be invoked more than once", async () => {
                const d = STAKE_REWARD_CONFIG_DEFAULTS;
                await program.methods
                    .updateRewardConfig(new BN(1_000), d.maxPeriodRewards, d.rewardPeriodSeconds, d.maxTotalRewards)
                    .accountsStrict(updateRewardConfigAccounts(provider.wallet.publicKey))
                    .rpc();
                const mid = await program.account.stakeRewardConfig.fetch(stakeRewardConfigPda);
                assert.equal(mid.maxRewardBps.toNumber(), 1_000);
                await program.methods
                    .updateRewardConfig(new BN(75), d.maxPeriodRewards, d.rewardPeriodSeconds, d.maxTotalRewards)
                    .accountsStrict(updateRewardConfigAccounts(provider.wallet.publicKey))
                    .rpc();
                const after = await program.account.stakeRewardConfig.fetch(stakeRewardConfigPda);
                assert.equal(after.maxRewardBps.toNumber(), 75);
            });

            it("non-upgrade-authority cannot call update_reward_config", async () => {
                const d = STAKE_REWARD_CONFIG_DEFAULTS;
                try {
                    await program.methods
                        .updateRewardConfig(new BN(100), d.maxPeriodRewards, d.rewardPeriodSeconds, d.maxTotalRewards)
                        .accountsStrict(updateRewardConfigAccounts(rewardsAdmin.publicKey))
                        .signers([rewardsAdmin])
                        .rpc();
                    assert.fail("Should have thrown — only the program upgrade authority may update reward config");
                } catch (err) {
                    expect(err).to.exist;
                }
            });
        });

        // ── Default 0.75% cap enforcement ─────────────────────────────────────
        // These tests verify the default maxRewardBps=75 (0.75%) cap behavior.
        // The same behavior applies when the account is auto-created via init_if_needed
        // (maxRewardBps=0), because the processor treats 0 as DEFAULT_BPS=75.

        describe("default 0.75% cap enforcement", () => {
            it("rejects reward above 0.75% of total_assets with RewardExceedsMaxDelta", async () => {
                const totalAssets = (await getAccount(provider.connection, vaultTokenAccount)).amount;
                const overCapAmount = (totalAssets * BigInt(76)) / BigInt(10_000) + BigInt(1); // just over 0.75%
                const rewardsRecordPda = makeRewardsRecordPda(++publishRewardsId, overCapAmount);
                try {
                    await program.methods
                        .publishRewards(publishRewardsId, new BN(overCapAmount.toString()))
                        .accountsStrict(publishRewardsAccounts(rewardsRecordPda))
                        .signers([rewardsAdmin])
                        .rpc();
                    assert.fail("Should have thrown RewardExceedsMaxDelta");
                } catch (err) {
                    expect(err.toString()).to.include("RewardExceedsMaxDelta");
                }
            });

            it("allows reward at exactly 0.75% of total_assets", async () => {
                const totalAssets = (await getAccount(provider.connection, vaultTokenAccount)).amount;
                const exactCapAmount = (totalAssets * BigInt(75)) / BigInt(10_000); // exactly 0.75%
                const rewardsRecordPda = makeRewardsRecordPda(++publishRewardsId, exactCapAmount);
                await program.methods
                    .publishRewards(publishRewardsId, new BN(exactCapAmount.toString()))
                    .accountsStrict(publishRewardsAccounts(rewardsRecordPda))
                    .signers([rewardsAdmin])
                    .rpc();
            });
        });

        // ── Config changes via update_max_reward_bps ─────────────────────────

        describe("update_max_reward_bps", () => {
            it("upgrade authority can raise cap: emits event and updates stored state", async () => {
                const configBefore = await program.account.stakeRewardConfig.fetch(stakeRewardConfigPda);
                const oldBps = configBefore.maxRewardBps.toNumber();
                const newBps = 5_000; // 50%

                const sig = await program.methods
                    .updateMaxRewardBps(new BN(newBps))
                    .accountsStrict(updateMaxRewardBpsAccounts())
                    .rpc({ commitment: "confirmed", skipPreflight: true });

                // Verify on-chain state updated
                const configAfter = await program.account.stakeRewardConfig.fetch(stakeRewardConfigPda);
                assert.equal(configAfter.maxRewardBps.toNumber(), newBps, "stored maxRewardBps must reflect new value");
                assert.equal(configAfter.bump, configBefore.bump, "bump must not change on update");

                // Verify MaxRewardBpsUpdated event
                const events = await parseEvents(sig);
                const event = events.find(e => e.name === "maxRewardBpsUpdated");
                assert.isDefined(event, "MaxRewardBpsUpdated event must be emitted");
                assert.equal((event.data.oldBps as BN).toNumber(), oldBps, "event old_bps must reflect previous stored value");
                assert.equal((event.data.newBps as BN).toNumber(), newBps, "event new_bps must match update argument");
            });

            it("raised cap (50%) allows reward between old and new cap: 30% reward succeeds", async () => {
                // Precondition: cap is now 50% from the previous test
                const configCheck = await program.account.stakeRewardConfig.fetch(stakeRewardConfigPda);
                assert.equal(configCheck.maxRewardBps.toNumber(), 5_000, "precondition: cap should be 50%");

                const totalAssets = (await getAccount(provider.connection, vaultTokenAccount)).amount;
                const amount = (totalAssets * BigInt(30)) / BigInt(100); // 30%: blocked at 20%, allowed at 50%
                const rewardsRecordPda = makeRewardsRecordPda(++publishRewardsId, amount);
                await program.methods
                    .publishRewards(publishRewardsId, new BN(amount.toString()))
                    .accountsStrict(publishRewardsAccounts(rewardsRecordPda))
                    .signers([rewardsAdmin])
                    .rpc();
            });

            it("upgrade authority can lower cap: stored state and event both reflect change", async () => {
                const configBefore = await program.account.stakeRewardConfig.fetch(stakeRewardConfigPda);
                const oldBps = configBefore.maxRewardBps.toNumber();
                const newBps = 2_000; // restore to 20%

                const sig = await program.methods
                    .updateMaxRewardBps(new BN(newBps))
                    .accountsStrict(updateMaxRewardBpsAccounts())
                    .rpc({ commitment: "confirmed", skipPreflight: true });

                const configAfter = await program.account.stakeRewardConfig.fetch(stakeRewardConfigPda);
                assert.equal(configAfter.maxRewardBps.toNumber(), newBps, "stored maxRewardBps must reflect lowered value");

                const events = await parseEvents(sig);
                const event = events.find(e => e.name === "maxRewardBpsUpdated");
                assert.isDefined(event, "MaxRewardBpsUpdated event must be emitted on lower");
                assert.equal((event.data.oldBps as BN).toNumber(), oldBps, "event old_bps must be previous cap");
                assert.equal((event.data.newBps as BN).toNumber(), newBps, "event new_bps must be new cap");
            });

            it("lowered cap re-enforces limit: reward above new cap is rejected", async () => {
                // Precondition: cap is back to 20%
                const configCheck = await program.account.stakeRewardConfig.fetch(stakeRewardConfigPda);
                assert.equal(configCheck.maxRewardBps.toNumber(), 2_000, "precondition: cap should be restored to 20%");

                const totalAssets = (await getAccount(provider.connection, vaultTokenAccount)).amount;
                const overCapAmount = (totalAssets * BigInt(30)) / BigInt(100); // 30% — over 20% cap
                const rewardsRecordPda = makeRewardsRecordPda(++publishRewardsId, overCapAmount);
                try {
                    await program.methods
                        .publishRewards(publishRewardsId, new BN(overCapAmount.toString()))
                        .accountsStrict(publishRewardsAccounts(rewardsRecordPda))
                        .signers([rewardsAdmin])
                        .rpc();
                    assert.fail("Should have thrown RewardExceedsMaxDelta after restoring 20% cap");
                } catch (err) {
                    expect(err.toString()).to.include("RewardExceedsMaxDelta");
                }
            });

            it("non-upgrade-authority cannot update max_reward_bps", async () => {
                try {
                    await program.methods
                        .updateMaxRewardBps(new BN(9_000))
                        .accountsStrict({
                            stakeConfig: stakeConfigPda,
                            stakeRewardConfig: stakeRewardConfigPda,
                            signer: rewardsAdmin.publicKey,
                            programData: programDataPda,
                        })
                        .signers([rewardsAdmin])
                        .rpc();
                    assert.fail("Should have thrown error");
                } catch (err) {
                    expect(err).to.exist;
                }
            });

            it("rejects max_reward_bps of 0 with InvalidMaxRewardBps", async () => {
                try {
                    await program.methods
                        .updateMaxRewardBps(new BN(0))
                        .accountsStrict(updateMaxRewardBpsAccounts())
                        .rpc();
                    assert.fail("Should have thrown error");
                } catch (err) {
                    expect(err.toString()).to.include("InvalidMaxRewardBps");
                }
            });

            it("rejects max_reward_bps above 10_000 (100%) with InvalidMaxRewardBps", async () => {
                try {
                    await program.methods
                        .updateMaxRewardBps(new BN(10_001))
                        .accountsStrict(updateMaxRewardBpsAccounts())
                        .rpc();
                    assert.fail("Should have thrown error");
                } catch (err) {
                    expect(err.toString()).to.include("InvalidMaxRewardBps");
                }
            });
        });

        describe("period, cooldown, and lifetime caps", () => {
            const stakeRewardConfigAdminAccounts = () => ({
                stakeConfig: stakeConfigPda,
                stakeRewardConfig: stakeRewardConfigPda,
                signer: provider.wallet.publicKey,
                programData: programDataPda,
            });

            it("stores default absolute/cooldown/lifetime values", async () => {
                // Runs after parent StakeRewardConfig beforeEach (1s cooldown); restore default before fetch.
                await program.methods
                    .updateRewardPeriodSeconds(STAKE_REWARD_CONFIG_DEFAULTS.rewardPeriodSeconds)
                    .accountsStrict(stakeRewardConfigAdminAccounts())
                    .rpc();
                const cfg = await program.account.stakeRewardConfig.fetch(stakeRewardConfigPda);
                assert.equal(
                    cfg.maxPeriodRewards.toString(),
                    STAKE_REWARD_CONFIG_DEFAULTS.maxPeriodRewards.toString(),
                    "default max_period_rewards should be 1,000,000 wYLDS (6 decimals)"
                );
                assert.equal(
                    cfg.rewardPeriodSeconds.toNumber(),
                    STAKE_REWARD_CONFIG_DEFAULTS.rewardPeriodSeconds.toNumber(),
                    "default reward_period_seconds should be 3540"
                );
                assert.equal(
                    cfg.maxTotalRewards.toString(),
                    STAKE_REWARD_CONFIG_DEFAULTS.maxTotalRewards.toString(),
                    "default max_total_rewards should be 10,000,000 wYLDS (6 decimals)"
                );
            });

            it("enforces per-call absolute cap", async () => {
                await program.methods
                    .updateRewardPeriodSeconds(new BN(1))
                    .accountsStrict(stakeRewardConfigAdminAccounts())
                    .rpc();
                await program.methods
                    .updateMaxPeriodRewards(new BN(1))
                    .accountsStrict(stakeRewardConfigAdminAccounts())
                    .rpc();
                await sleep(REWARD_COOLDOWN_TEST_SLEEP_MS);

                const rewardsRecordPda = makeRewardsRecordPda(++publishRewardsId, BigInt(2));
                try {
                    await program.methods
                        .publishRewards(publishRewardsId, new BN(2))
                        .accountsStrict(publishRewardsAccounts(rewardsRecordPda))
                        .signers([rewardsAdmin])
                        .rpc();
                    assert.fail("Should have thrown ExceedsPeriodRewardCap");
                } catch (err) {
                    expect(err.toString()).to.include("ExceedsPeriodRewardCap");
                }
            });

            it("enforces cooldown between consecutive publishes", async () => {
                await program.methods
                    .updateMaxPeriodRewards(new BN("1000000000000"))
                    .accountsStrict(stakeRewardConfigAdminAccounts())
                    .rpc();
                // Parent beforeEach leaves reward_period_seconds = 1 and sleeps so the first publish
                // here is allowed even after prior tests published. Raise the cooldown only after that
                // publish, so the immediate second publish hits RewardCooldownNotElapsed.
                const firstRewardRecordPda = makeRewardsRecordPda(++publishRewardsId, BigInt(1));
                await program.methods
                    .publishRewards(publishRewardsId, new BN(1))
                    .accountsStrict(publishRewardsAccounts(firstRewardRecordPda))
                    .signers([rewardsAdmin])
                    .rpc();

                await program.methods
                    .updateRewardPeriodSeconds(new BN(3600))
                    .accountsStrict(stakeRewardConfigAdminAccounts())
                    .rpc();

                const secondRewardRecordPda = makeRewardsRecordPda(++publishRewardsId, BigInt(1));
                try {
                    await program.methods
                        .publishRewards(publishRewardsId, new BN(1))
                        .accountsStrict(publishRewardsAccounts(secondRewardRecordPda))
                        .signers([rewardsAdmin])
                        .rpc();
                    assert.fail("Should have thrown RewardCooldownNotElapsed");
                } catch (err) {
                    expect(err.toString()).to.include("RewardCooldownNotElapsed");
                }
            });

            it("enforces lifetime rewards cap", async () => {
                const cfgBefore = await program.account.stakeRewardConfig.fetch(stakeRewardConfigPda);
                const distributed = new BN(cfgBefore.totalRewardsDistributed.toString());

                await program.methods
                    .updateRewardPeriodSeconds(new BN(1))
                    .accountsStrict(stakeRewardConfigAdminAccounts())
                    .rpc();
                await program.methods
                    .updateMaxPeriodRewards(new BN("1000000000000"))
                    .accountsStrict(stakeRewardConfigAdminAccounts())
                    .rpc();
                await program.methods
                    .updateMaxTotalRewards(distributed.add(new BN(1)))
                    .accountsStrict(stakeRewardConfigAdminAccounts())
                    .rpc();
                await sleep(REWARD_COOLDOWN_TEST_SLEEP_MS);

                const rewardsRecordPda = makeRewardsRecordPda(++publishRewardsId, BigInt(2));
                try {
                    await program.methods
                        .publishRewards(publishRewardsId, new BN(2))
                        .accountsStrict(publishRewardsAccounts(rewardsRecordPda))
                        .signers([rewardsAdmin])
                        .rpc();
                    assert.fail("Should have thrown ExceedsLifetimeRewardCap");
                } catch (err) {
                    expect(err.toString()).to.include("ExceedsLifetimeRewardCap");
                }
            });
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
                newVaultTokenAccountOwner,
                Keypair.generate()
            );
        });

        it("allows freeze admin update by upgrade authority", async () => {
            await program.methods
                .updateFreezeAdministrators([freezeAdmin.publicKey, addFreezeAdmin.publicKey])
                .accountsStrict({
                    stakeConfig: stakeConfigPda,
                    signer: provider.wallet.publicKey,
                    programData: programData,
                })
                .rpc();
            //fetch config and verify
            const config = await program.account.stakeConfig.fetch(stakeConfigPda);
            const freezeAdmins = config.freezeAdministrators.map(pk => pk.toBase58());
            assert.includeMembers(freezeAdmins, [freezeAdmin.publicKey.toBase58(), addFreezeAdmin.publicKey.toBase58()]);
        });

        it("disallows freeze admin update by non upgrade authority", async () => {
            try {
                await program.methods
                    .updateFreezeAdministrators([freezeAdmin.publicKey, addFreezeAdmin.publicKey])
                    .accountsStrict({
                        stakeConfig: stakeConfigPda,
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
                    stakeConfig: stakeConfigPda,
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
                    stakeConfig: stakeConfigPda,
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
                    stakeConfig: stakeConfigPda,
                    signer: provider.wallet.publicKey,
                    programData: programData,
                })
                .rpc();
            //fetch config and verify
            const config = await program.account.stakeConfig.fetch(stakeConfigPda);
            const rewardsAdmins = config.rewardsAdministrators.map(pk => pk.toBase58());
            assert.includeMembers(rewardsAdmins, [rewardsAdmin.publicKey.toBase58(), addRewardsAdmin.publicKey.toBase58()]);
        });

        it("disallows rewards admin update by non upgrade authority", async () => {
            try {
                await program.methods
                    .updateRewardsAdministrators([rewardsAdmin.publicKey, addRewardsAdmin.publicKey])
                    .accountsStrict({
                        stakeConfig: stakeConfigPda,
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
        it("new rewards admin can NOT publish rewards unless mint program updated", async () => {
            try {
                const amount = 100_000_000_000;
                const [rewardsRecordPda] = anchor.web3.PublicKey.findProgramAddressSync(
                    [
                        Buffer.from("reward_record"),
                        Buffer.from(new Uint32Array([++publishRewardsId]).buffer),
                        Buffer.from(new BigUint64Array([createBigInt(amount)]).buffer)
                    ],
                    program.programId);

                await program.methods
                    .publishRewards(publishRewardsId, new BN(amount))
                    .accountsStrict({
                        stakeConfig: stakeConfigPda,
                        stakeVaultTokenAccountConfig: stakeVaultTokenAccountConfigPda,
                        mintConfig: configPda,
                        externalMintAuthority: externalMintAuthorityPda,
                        mintProgram: mintProgram.programId,
                        thisProgram: program.programId,
                        vaultMintAllowedExternalPrograms: allowedExternalMintProgramsPda,
                        admin: addRewardsAdmin.publicKey,
                        rewardsMint: vaultedToken,
                        rewardsMintAuthority: rewardsMintAuthorityPda,
                        vaultTokenAccount: vaultTokenAccount,
                        vaultAuthority: vaultAuthorityPda,
                        mint: mintedToken,
                        rewardRecord: rewardsRecordPda,
                        stakeRewardConfig: stakeRewardConfigPda,
                        
                        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
                        systemProgram: anchor.web3.SystemProgram.programId,
                    })
                    .signers([addRewardsAdmin])
                    .rpc();
                assert.fail("Should have thrown error");
            } catch (err) {
                expect(err).to.exist;
            }
        });

    });

    describe("overflow deposits", () => {

        before(async () => {
            const mintConfig = await mintProgram.account.config.fetch(configPda);
            const mintProgramVaultToken = mintConfig.vault; //USDC

            const user2UsdcBalance = await getAccount(
                provider.connection,
                user2MintProgramVaultedTokenAccount
            );
            const [mintProgramMintAuthorityPda] = anchor.web3.PublicKey.findProgramAddressSync(
                [Buffer.from("mint_authority")],
                mintProgram.programId
            );

            /* create large deposit to push total assets close to u64 max */
            await mintProgram.methods
                .deposit(new BN(user2UsdcBalance.amount))
                .accountsStrict({
                    config: configPda,
                    vaultTokenAccountConfig: vaultTokenAccountConfigPda,
                    vaultTokenAccount: mintProgramVaultTokenAccount,
                    mint: vaultedToken,
                    mintAuthority: mintProgramMintAuthorityPda,
                    signer: user2.publicKey,
                    userVaultTokenAccount: user2MintProgramVaultedTokenAccount, //USDC
                    userMintTokenAccount: user2VaultTokenAccount, // WYLDS
                    tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID
                })
                .signers([user2])
                .rpc().catch(err => {
                    console.log(`USDC deposit error: ${err}`);
                    console.dir(err);
                    throw err;
                });

            const user2VaultedTokenAccount = await getAccount(provider.connection, user2VaultTokenAccount);
            assert.isTrue(user2VaultedTokenAccount.amount > hundredBillsLarge, "User 2 has more than 100 billion vaulted tokens");
        });
        after(async () => {
            vaultSummary("after overflow deposit")
        });

        it("billion dollar deposit works", async () => {
            const userVaultedTokenBalanceBefore = await getAccount(provider.connection, user2VaultTokenAccount);
            await program.methods
                .deposit(new BN(userVaultedTokenBalanceBefore.amount))
                .accountsStrict({
                    stakeConfig: stakeConfigPda,
                    stakeVaultTokenAccountConfig: stakeVaultTokenAccountConfigPda,
                    vaultTokenAccount: vaultTokenAccount,
                    vaultAuthority: vaultAuthorityPda,
                    mint: mintedToken,
                    vaultMint: vaultedToken,
                    mintAuthority: mintAuthorityPda,
                    signer: user2.publicKey,
                    userVaultTokenAccount: user2VaultTokenAccount,
                    userMintTokenAccount: user2MintTokenAccount,
                    stakePriceConfig: stakePriceConfigPda,
                    tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID
                })
                .signers([user2])
                .rpc()
                .catch(err => {
                    console.log(`AUTO deposit error: ${err}`);
                    console.dir(err);
                });
        });
    });
});
