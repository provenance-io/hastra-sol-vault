import * as anchor from "@coral-xyz/anchor";
import {Program} from "@coral-xyz/anchor";
import {VaultMint} from "../target/types/vault_mint";
import {VaultStake} from "../target/types/vault_stake";
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

describe("vault-stake", () => {
    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);

    const mintProgram = anchor.workspace.VaultMint as Program<VaultMint>;
    const program = anchor.workspace.VaultStake as Program<VaultStake>;

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

    let user: Keypair;
    let user2: Keypair;
    let userMintTokenAccount: PublicKey;
    let userVaultTokenAccount: PublicKey;
    let user2MintTokenAccount: PublicKey;
    let user2VaultTokenAccount: PublicKey;
    let mintProgramVaultTokenAccount: PublicKey;
    let mintProgramVaultTokenAccountOwner: PublicKey;
    let externalMintAuthorityPda: PublicKey;
    let rewardsMintAuthorityPda: PublicKey;

    let freezeAdmin: Keypair;
    let rewardsAdmin: Keypair;

    let unbondingPeriod: BN;

    let publishRewardsId = 0;

    const ONE_BIG_SHARE = createBigInt(1_000_000);
    const ONE_BIG_TOKEN = createBigInt(1_000_000);
    const ONE_BIG_EXCHANGE_RATE = createBigInt(1_000_000_000);
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
    const sharesToAssets = async (shares: bigint): Promise<bigint> => {
        let sig = await program.methods.sharesToAssets(new BN(shares))
            .accountsStrict({
                stakeConfig: stakeConfigPda,
                mint: mintedToken,
                vaultTokenAccount: vaultTokenAccount,
                vaultAuthority: vaultAuthorityPda,
            })
            .rpc();
        //let the transaction bake
        await new Promise(resolve => setTimeout(resolve, 1000));
        return await parsedTransactionReturnData(sig);
    }

    const assetsToShares = async (assets: bigint): Promise<bigint> => {
        let sig = await program.methods.assetsToShares(new BN(assets))
            .accountsStrict({
                stakeConfig: stakeConfigPda,
                mint: mintedToken,
                vaultTokenAccount: vaultTokenAccount,
                vaultAuthority: vaultAuthorityPda,
            })
            .rpc();
        //let the transaction bake
        await new Promise(resolve => setTimeout(resolve, 1000));
        return await parsedTransactionReturnData(sig);
    }

    const exchangeRate = async (): Promise<bigint> => {
        let sig = await program.methods.exchangeRate()
            .accountsStrict({
                stakeConfig: stakeConfigPda,
                mint: mintedToken,
                vaultTokenAccount: vaultTokenAccount,
                vaultAuthority: vaultAuthorityPda,
            })
            .rpc();
        //let the transaction bake
        await new Promise(resolve => setTimeout(resolve, 1000));
        return await parsedTransactionReturnData(sig);
    }

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

        unbondingPeriod = new BN(10); // seconds

        // Airdrop SOL
        await provider.connection.requestAirdrop(user.publicKey, 100 * LAMPORTS_PER_SOL);
        await provider.connection.requestAirdrop(user2.publicKey, 100 * LAMPORTS_PER_SOL);
        await provider.connection.requestAirdrop(freezeAdmin.publicKey, 2 * LAMPORTS_PER_SOL);
        await provider.connection.requestAirdrop(rewardsAdmin.publicKey, 2 * LAMPORTS_PER_SOL);
        await provider.connection.requestAirdrop(badVaultTokenAccountOwnerPublicKey, 10 * LAMPORTS_PER_SOL);

        // Wait for airdrops
        await new Promise(resolve => setTimeout(resolve, 1000));

        // Create mint token (e.g., PRIME)
        mintedToken = await createMint(
            provider.connection,
            provider.wallet.payer,
            mintAuthorityPda,
            freezeAuthorityPda,
            6,
        );

        // Derive PDAs
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

        [programDataPda] = PublicKey.findProgramAddressSync(
            [program.programId.toBuffer()],
            BPF_LOADER_UPGRADEABLE_ID
        );

        // Create vault token account
        vaultTokenAccount = await createAccount(
            provider.connection,
            provider.wallet.payer,
            vaultedToken,
            provider.wallet.publicKey
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

        user2MintTokenAccount = await createAccount(
            provider.connection,
            provider.wallet.payer,
            mintedToken,
            user2.publicKey
        );

        user2VaultTokenAccount = await createAccount(
            provider.connection,
            provider.wallet.payer,
            vaultedToken,
            user2.publicKey
        );

        mintProgramVaultTokenAccountOwner = Keypair.fromSeed(Buffer.alloc(32, 72)).publicKey;
        mintProgramVaultTokenAccount = await getAssociatedTokenAddress(
            mintConfig.vault,
            mintProgramVaultTokenAccountOwner
        );

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
                user.publicKey
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
            const user2MintProgramVaultedTokenAccount = await createAccount(
                provider.connection,
                provider.wallet.payer,
                mintProgramVaultToken,
                user2.publicKey
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
                    .initialize(unbondingPeriod, tooManyAdmins, [rewardsAdmin.publicKey])
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
                    .initialize(unbondingPeriod, [freezeAdmin.publicKey], tooManyAdmins)
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

        it("fails with invalid unbonding period", async () => {
            const tooManyAdmins = Array(6).fill(Keypair.generate().publicKey);
            try {
                await program.methods
                    .initialize(new BN(0), [freezeAdmin.publicKey], tooManyAdmins)
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
            await program.methods
                .initialize(unbondingPeriod, [freezeAdmin.publicKey], [rewardsAdmin.publicKey])
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
            assert.ok(config.unbondingPeriod.eq(unbondingPeriod));
            assert.ok(!config.paused);
        });

        it("fails when called twice", async () => {
            try {
                await program.methods
                    .initialize(unbondingPeriod, [freezeAdmin.publicKey], [rewardsAdmin.publicKey])
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

    describe("deposit", () => {
        it("prevents inflation attack with virtual offsets", async () => {
            /*
            ## Vault inflation attack
                ### Attack scenario

                **Initial state:**
                - Vault balance: 0 wYLDS
                - Total supply: 0 PRIME

                **Step 1: Attacker makes first deposit**
                Attacker deposits: 1 wYLDS
                Calculation: shares = 1 (initial 1:1 ratio)
                Result: Attacker gets 1 PRIME share

                New state:
                - Vault balance: 1 wYLDS
                - Total supply: 1 PRIME
                - Attacker owns: 1 PRIME (100% of supply)

                **Step 2: Attacker donates tokens directly to vault**
                Attacker transfers 10,000 wYLDS directly to vault address
                (bypassing deposit function - just a regular SPL token transfer)

                New state:
                - Vault balance: 10,001 wYLDS
                - Total supply: 1 PRIME
                - Price per share: 10,001 wYLDS per PRIME

                **Step 3: Victim deposits**
                Victim deposits: 9,999 wYLDS
                Calculation: shares = (9,999 * 1) / 10,001 = 0.9998...
                Integer division: 0.9998... rounds DOWN to 0
                Result: Victim gets 0 PRIME shares!

                New state:
                - Vault balance: 19,999 wYLDS (10,001 + 9,999)
                - Total supply: 1 PRIME (no new shares minted!)
                - Attacker still owns: 1 PRIME (100% of supply)

                **Step 4: Attacker redeems**
                Attacker redeems 1 PRIME
                Calculation: redeem = (1 * 19,999) / 1 = 19,999 wYLDS
                Result: Attacker receives 19,999 wYLDS

                Profit: 19,999 - 1 - 10,000 = 9,998 wYLDS stolen from victim!!
             */

            const user1InitialVaultedBalance = (await getAccount(provider.connection, userVaultTokenAccount)).amount;

            // step 1 - try to deposit a small amount
            await program.methods
                .deposit(new BN(ONE_BIG_TOKEN)) // 1 token, 1 share at 1:1
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
                    tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID
                })
                .signers([user])
                .rpc();

            // assert that the user received their shares at 1:1
            const userShares = (await getAccount(provider.connection, userMintTokenAccount)).amount;
            assert.equal(userShares, ONE_BIG_SHARE, "User should have 1 share at 1:1 ratio");
            const userAssets = await sharesToAssets(userShares);
            assert.equal(userAssets, ONE_BIG_TOKEN, "User should have 1 assets");
            const userQueriedShares = await assetsToShares(userAssets);
            assert.equal(userQueriedShares, ONE_BIG_SHARE, "User should have 1 share at 1:1 ratio");
            const exchangeRateInitial = await exchangeRate();
            assert.equal(exchangeRateInitial, ONE_BIG_EXCHANGE_RATE, "Exchange rate should be 1:1 initially");

            // step 2 - transfer directly to the vault to try to inflate the value of shares
            await transfer(provider.connection, user, userVaultTokenAccount, vaultTokenAccount, user.publicKey, ONE_BIG_TOKEN * createBigInt(10_000)); // 10,000 wYLDS

            // step 3 - victim (user 2) deposits
            await program.methods
                .deposit(new BN(ONE_BIG_TOKEN * createBigInt(10_000))) // 10,000 wYLDS
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
                    tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID
                })
                .signers([user2])
                .rpc();

            // confirm shares to assets
            const user1Shares = (await getAccount(provider.connection, userMintTokenAccount)).amount;
            const user2Shares = (await getAccount(provider.connection, user2MintTokenAccount)).amount;

            assert.equal(user1Shares, ONE_BIG_SHARE, "User 1 should have 1.000000 shares");
            /// the victim should receive just under 1 share due to rounding and their deposit being slightly less valuable
            assert.equal(user2Shares, createBigInt(1_999_600), "User 2 should roughly twice as many shares as user 1");

            const user1Assets = await sharesToAssets(user1Shares);
            const user2Assets = await sharesToAssets(user2Shares);

            assert.equal(user1Assets, createBigInt(5_001_000_100), "User 1 should have 5,001 plus some dust assets");
            assert.equal(user2Assets, createBigInt(9_999_999_799), "User 2 should have 9,999 plus some dust assets");

            //prior to redemption, check vault balances
            const vaultBalanceBefore = (await getAccount(provider.connection, vaultTokenAccount)).amount;
            assert.equal(vaultBalanceBefore, ONE_BIG_TOKEN * createBigInt(20_001), "Vault should have all deposits");
            assert.isTrue(vaultBalanceBefore > (user1Assets + user2Assets), "There will be rounding dust");

            // step 4 - attacker redeems
            // first they need to unbond
            const [ticketPda] = anchor.web3.PublicKey.findProgramAddressSync(
                [Buffer.from("ticket"), user.publicKey.toBuffer()],
                program.programId
            );
            await program.methods.unbond(new BN(user1Shares))
                .accountsStrict({
                    stakeConfig: stakeConfigPda,
                    mint: mintedToken,
                    signer: user.publicKey,
                    userMintTokenAccount: userMintTokenAccount,
                    ticket: ticketPda,
                    systemProgram: anchor.web3.SystemProgram.programId,
                })
                .signers([user])
                .rpc();

            // wait for >10 seconds unbonding period
            await new Promise(resolve => setTimeout(resolve, 15000));
            await program.methods.redeem()
                .accountsStrict({
                    stakeConfig: stakeConfigPda,
                    vaultTokenAccount: vaultTokenAccount,
                    stakeVaultTokenAccountConfig: stakeVaultTokenAccountConfigPda,
                    vaultAuthority: vaultAuthorityPda,
                    signer: user.publicKey,
                    userVaultTokenAccount: userVaultTokenAccount,
                    userMintTokenAccount: userMintTokenAccount,
                    mint: mintedToken,
                    vaultMint: vaultedToken,
                    tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
                    ticket: ticketPda
                }).signers([user])
                .rpc()

            // post redemption, check balances
            const totalAssets = (await getAccount(provider.connection, vaultTokenAccount)).amount;
            const totalShares = (await getMint(provider.connection, mintedToken)).supply;

            assert.equal(totalAssets, vaultBalanceBefore - user1Assets, "Total assets should reflect all deposits");
            assert.equal(totalShares, user2Shares, "Total shares should reflect only user 2 shares now");

            const userVaultBalanceAfter = (await getAccount(provider.connection, userVaultTokenAccount)).amount;
            // original wylds - initial deposit - direct transfer + redemption
            assert.equal(userVaultBalanceAfter, user1InitialVaultedBalance - ONE_BIG_TOKEN - (ONE_BIG_TOKEN * createBigInt(10_000)) + user1Assets, "User vault balance should be their withdrawn assets");

            const exchangeRateFinal = await exchangeRate();
            assert.equal(exchangeRateFinal, createBigInt("5001000100013"), "Exchange rate should be 1:5001 finally");

        });

        it("user 2 redeems", async () => {
            const vaultBalanceBefore = (await getAccount(provider.connection, vaultTokenAccount)).amount;
            const user2MintTokenBefore = (await getAccount(provider.connection, user2MintTokenAccount)).amount;
            const user2VaultBalanceBefore = (await getAccount(provider.connection, user2VaultTokenAccount)).amount;

            assert.equal(vaultBalanceBefore, createBigInt(14_999_999_900), "Vault should have all deposits");
            assert.equal(user2MintTokenBefore, createBigInt(1_999_600), "User 2 should still have 1,999,600 shares");
            assert.equal(user2VaultBalanceBefore, BIG_ZERO, "User 2 should not have any vault tokens");

            const [ticketPda] = anchor.web3.PublicKey.findProgramAddressSync(
                [Buffer.from("ticket"), user2.publicKey.toBuffer()],
                program.programId
            );
            await program.methods.unbond(new BN(user2MintTokenBefore))
                .accountsStrict({
                    stakeConfig: stakeConfigPda,
                    mint: mintedToken,
                    signer: user2.publicKey,
                    userMintTokenAccount: user2MintTokenAccount,
                    ticket: ticketPda,
                    systemProgram: anchor.web3.SystemProgram.programId,
                })
                .signers([user2])
                .rpc().catch(e => console.dir(e));

            // wait for >10 seconds unbonding period
            await new Promise(resolve => setTimeout(resolve, 15000));
            await program.methods.redeem()
                .accountsStrict({
                    stakeConfig: stakeConfigPda,
                    vaultTokenAccount: vaultTokenAccount,
                    stakeVaultTokenAccountConfig: stakeVaultTokenAccountConfigPda,
                    vaultAuthority: vaultAuthorityPda,
                    signer: user2.publicKey,
                    userVaultTokenAccount: user2VaultTokenAccount,
                    userMintTokenAccount: user2MintTokenAccount,
                    mint: mintedToken,
                    vaultMint: vaultedToken,
                    tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
                    ticket: ticketPda
                }).signers([user2])
                .rpc()

            const vaultBalanceAfter = (await getAccount(provider.connection, vaultTokenAccount)).amount;
            const user2MintTokenAfter = (await getAccount(provider.connection, user2MintTokenAccount)).amount;
            const user2VaultBalanceAfter = (await getAccount(provider.connection, user2VaultTokenAccount)).amount;

            assert.equal(vaultBalanceAfter, vaultBalanceBefore - user2VaultBalanceAfter, "Vault balance should reflect all redeems");
            assert.equal(user2MintTokenAfter, BIG_ZERO, "User should not have staked tokens after redeem");
            assert.ok(user2VaultBalanceAfter > user2VaultBalanceBefore, "User vault balance should reflect redeemed tokens");
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

    describe("unbond", () => {
        it("unbond ticket closes", async () => {
            const [ticketPda] = anchor.web3.PublicKey.findProgramAddressSync(
                [Buffer.from("ticket"), user.publicKey.toBuffer()],
                program.programId
            );
            await program.methods.unbond(new BN(1000))
                .accountsStrict({
                    stakeConfig: stakeConfigPda,
                    mint: mintedToken,
                    signer: user.publicKey,
                    userMintTokenAccount: userMintTokenAccount,
                    ticket: ticketPda,
                    systemProgram: anchor.web3.SystemProgram.programId,
                })
                .signers([user])
                .rpc();

            const t = await program.account.unbondingTicket.fetch(
                ticketPda
            );
            assert.equal(t.requestedAmount.toNumber(), new BN(1000).toNumber(), "Unbonding ticket should reflect requested amount");

            // wait for >10 seconds unbonding period
            await new Promise(resolve => setTimeout(resolve, 15000));
            await program.methods.redeem()
                .accountsStrict({
                    stakeConfig: stakeConfigPda,
                    vaultTokenAccount: vaultTokenAccount,
                    stakeVaultTokenAccountConfig: stakeVaultTokenAccountConfigPda,
                    vaultAuthority: vaultAuthorityPda,
                    signer: user.publicKey,
                    userVaultTokenAccount: userVaultTokenAccount,
                    userMintTokenAccount: userMintTokenAccount,
                    mint: mintedToken,
                    vaultMint: vaultedToken,
                    tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
                    ticket: ticketPda
                }).signers([user])
                .rpc()

            try {
                await program.account.unbondingTicket.fetch(
                    ticketPda
                );
                assert.fail("Redemption request should be closed");
            } catch (err) {
                expect(err).to.exist;
                expect(err.message).to.include("Account does not exist or has no data");
            }
        });

        it("unbond twice fails", async () => {
            const [ticketPda] = anchor.web3.PublicKey.findProgramAddressSync(
                [Buffer.from("ticket"), user.publicKey.toBuffer()],
                program.programId
            );
            await program.methods.unbond(new BN(1000))
                .accountsStrict({
                    stakeConfig: stakeConfigPda,
                    mint: mintedToken,
                    signer: user.publicKey,
                    userMintTokenAccount: userMintTokenAccount,
                    ticket: ticketPda,
                    systemProgram: anchor.web3.SystemProgram.programId,
                })
                .signers([user])
                .rpc();

            try {
                await program.methods.unbond(new BN(1000))
                    .accountsStrict({
                        stakeConfig: stakeConfigPda,
                        mint: mintedToken,
                        signer: user.publicKey,
                        userMintTokenAccount: userMintTokenAccount,
                        ticket: ticketPda,
                        systemProgram: anchor.web3.SystemProgram.programId,
                    })
                    .signers([user])
                    .rpc();
                assert.fail("Unbond request should have failed");
            } catch (err) {
                expect(err).to.exist;
            }
        });

        it("redeem without unbond", async () => {
            const [ticketPda] = anchor.web3.PublicKey.findProgramAddressSync(
                [Buffer.from("ticket"), user.publicKey.toBuffer()],
                program.programId
            );

            try {
                await program.methods.redeem()
                    .accountsStrict({
                        stakeConfig: stakeConfigPda,
                        vaultTokenAccount: vaultTokenAccount,
                        stakeVaultTokenAccountConfig: stakeVaultTokenAccountConfigPda,
                        vaultAuthority: vaultAuthorityPda,
                        signer: user.publicKey,
                        userVaultTokenAccount: userVaultTokenAccount,
                        userMintTokenAccount: userMintTokenAccount,
                        mint: mintedToken,
                        vaultMint: vaultedToken,
                        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
                        ticket: ticketPda
                    }).signers([user])
                    .rpc()
                assert.fail("Should have thrown error");
            } catch (err) {
                expect(err).to.exist;
            }
        });

        it("closes out unbonding tickets", async () => {
            const [ticketPda] = anchor.web3.PublicKey.findProgramAddressSync(
                [Buffer.from("ticket"), user.publicKey.toBuffer()],
                program.programId
            );

            // wait for >10 seconds unbonding period which was created in the double bond test
            await new Promise(resolve => setTimeout(resolve, 15000));
            await program.methods.redeem()
                .accountsStrict({
                    stakeConfig: stakeConfigPda,
                    vaultTokenAccount: vaultTokenAccount,
                    stakeVaultTokenAccountConfig: stakeVaultTokenAccountConfigPda,
                    vaultAuthority: vaultAuthorityPda,
                    signer: user.publicKey,
                    userVaultTokenAccount: userVaultTokenAccount,
                    userMintTokenAccount: userMintTokenAccount,
                    mint: mintedToken,
                    vaultMint: vaultedToken,
                    tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
                    ticket: ticketPda
                }).signers([user])
                .rpc()
        });
    });

    describe("paused protocol", () => {
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
        it("prevents unbond when paused", async () => {
            try {
                const [ticketPda] = anchor.web3.PublicKey.findProgramAddressSync(
                    [Buffer.from("ticket"), user.publicKey.toBuffer()],
                    program.programId
                );
                await program.methods.unbond(new BN(1000))
                    .accountsStrict({
                        stakeConfig: stakeConfigPda,
                        mint: mintedToken,
                        signer: user.publicKey,
                        userMintTokenAccount: userMintTokenAccount,
                        ticket: ticketPda,
                        systemProgram: anchor.web3.SystemProgram.programId,
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
                const amount = 1_000_000_000;
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
                        admin: rewardsAdmin.publicKey,
                        rewardsMint: vaultedToken,
                        rewardsMintAuthority: rewardsMintAuthorityPda,
                        vaultTokenAccount: vaultTokenAccount,
                        vaultAuthority: vaultAuthorityPda,
                        mint: mintedToken,
                        rewardRecord: rewardsRecordPda,
                        tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
                        systemProgram: anchor.web3.SystemProgram.programId,
                    })
                    .signers([rewardsAdmin])
                    .rpc();

                assert.fail("Should have thrown error");
            } catch (err) {
                expect(err).to.exist;
                expect(err.toString()).to.include("ProtocolPaused");
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
        after(async () => {
            vaultSummary("after rewards")
        });

        it("publish rewards", async () => {

            const rateBefore = await exchangeRate();

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
                    admin: rewardsAdmin.publicKey,
                    rewardsMint: vaultedToken,
                    rewardsMintAuthority: rewardsMintAuthorityPda,
                    vaultTokenAccount: vaultTokenAccount,
                    vaultAuthority: vaultAuthorityPda,
                    mint: mintedToken,
                    rewardRecord: rewardsRecordPda,
                    tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
                    systemProgram: anchor.web3.SystemProgram.programId,
                })
                .signers([rewardsAdmin])
                .rpc();

            const rateAfter = await exchangeRate();
            assert.isTrue(rateAfter > rateBefore, "Exchange rate should increase after publishing rewards");
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
                        admin: rewardsAdmin.publicKey,
                        rewardsMint: vaultedToken,
                        rewardsMintAuthority: rewardsMintAuthorityPda,
                        vaultTokenAccount: vaultTokenAccount,
                        vaultAuthority: vaultAuthorityPda,
                        mint: mintedToken,
                        rewardRecord: rewardsRecordPda,
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
            const amount = 1_000_000_000;
            const [rewardsRecordPda1] = anchor.web3.PublicKey.findProgramAddressSync(
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
                    admin: rewardsAdmin.publicKey,
                    rewardsMint: vaultedToken,
                    rewardsMintAuthority: rewardsMintAuthorityPda,
                    vaultTokenAccount: vaultTokenAccount,
                    vaultAuthority: vaultAuthorityPda,
                    mint: mintedToken,
                    rewardRecord: rewardsRecordPda1,
                    tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
                    systemProgram: anchor.web3.SystemProgram.programId,
                })
                .signers([rewardsAdmin])
                .rpc();

            const [rewardsRecordPda2] = anchor.web3.PublicKey.findProgramAddressSync(
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
                    admin: rewardsAdmin.publicKey,
                    rewardsMint: vaultedToken,
                    rewardsMintAuthority: rewardsMintAuthorityPda,
                    vaultTokenAccount: vaultTokenAccount,
                    vaultAuthority: vaultAuthorityPda,
                    mint: mintedToken,
                    rewardRecord: rewardsRecordPda2,
                    tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID,
                    systemProgram: anchor.web3.SystemProgram.programId,
                })
                .signers([rewardsAdmin])
                .rpc();

            const reward1 = await program.account.rewardPublicationRecord.fetch(rewardsRecordPda1);
            const reward2 = await program.account.rewardPublicationRecord.fetch(rewardsRecordPda2);

            assert.equal(reward1.amount.toNumber(), amount, "First reward amount should match");
            assert.equal(reward2.amount.toNumber(), amount, "Second reward amount should match");
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
                        admin: user.publicKey,
                        rewardsMint: vaultedToken,
                        rewardsMintAuthority: rewardsMintAuthorityPda,
                        vaultTokenAccount: vaultTokenAccount,
                        vaultAuthority: vaultAuthorityPda,
                        mint: mintedToken,
                        rewardRecord: rewardsRecordPda,
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
                        admin: addRewardsAdmin.publicKey,
                        rewardsMint: vaultedToken,
                        rewardsMintAuthority: rewardsMintAuthorityPda,
                        vaultTokenAccount: vaultTokenAccount,
                        vaultAuthority: vaultAuthorityPda,
                        mint: mintedToken,
                        rewardRecord: rewardsRecordPda,
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

        it("unbonding update by upgrade authority", async () => {
            await program.methods
                .updateConfig(new BN(240))
                .accountsStrict({
                    stakeConfig: stakeConfigPda,
                    signer: provider.wallet.publicKey,
                    programData: programData,
                })
                .rpc();

            //fetch config and verify
            const config = await program.account.stakeConfig.fetch(stakeConfigPda);
            assert.equal(config.unbondingPeriod.toNumber(), new BN(240).toNumber());
        });
    });

    describe("overflow deposits", () => {

        before(async () => {
            const mintConfig = await mintProgram.account.config.fetch(configPda);
            const mintProgramVaultToken = mintConfig.vault; //USDC
            const user2MintProgramVaultedTokenAccount = await getAssociatedTokenAddress(
                mintProgramVaultToken,
                user2.publicKey
            );

            const user2UsdcBalance = await getAccount(provider.connection, user2MintProgramVaultedTokenAccount);
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
                    tokenProgram: anchor.utils.token.TOKEN_PROGRAM_ID
                })
                .signers([user2])
                .rpc()
                .catch(err => {
                    console.log(`PRIME deposit error: ${err}`);
                    console.dir(err);
                });
        });
    });
});
