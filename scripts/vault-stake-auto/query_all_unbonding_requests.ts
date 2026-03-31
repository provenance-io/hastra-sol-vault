/**
 * DEPRECATED — Unbonding period removed in v0.0.5
 *
 * The two-step unbond → withdraw flow no longer exists. Redeem is now immediate.
 * No new UnbondingTicket accounts will be created by the current program.
 *
 * This script is retained solely for auditing any LEGACY tickets that were
 * created before the upgrade. If any are found, they can be closed (and rent
 * recovered) by calling `redeem` with the ticket PDA — the updated redeem
 * instruction will close the account and return rent to the signer automatically.
 *
 * If no tickets appear, the on-chain state is fully migrated and this script
 * can be removed.
 */
import * as anchor from "@coral-xyz/anchor";
import {Program} from "@coral-xyz/anchor";
import {VaultStakeAuto} from "../../target/types/vault_stake_auto";
import {STAKE_IDL} from "../cryptolib";

const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);

const program = anchor.workspace.VaultStakeAuto as Program<VaultStakeAuto>;

const main = async () => {
    // UnbondingTicket may have been removed from the IDL in a future cleanup.
    // Guard the lookup so the script fails with a clear message rather than a
    // cryptic TypeError if the account type no longer exists.
    const ticketIdlEntry = STAKE_IDL.accounts.find((a: { name: string }) => a.name === "UnbondingTicket");
    if (!ticketIdlEntry) {
        console.log("UnbondingTicket is no longer present in the IDL — migration complete, no legacy tickets possible.");
        return;
    }

    const accounts = await provider.connection.getProgramAccounts(program.programId, {
        filters: [
            {
                // Filter by account size (UnbondingTicket::LEN = discriminator + owner + amounts + timestamp)
                dataSize: 8 + 32 + 8 + 8 + 8,
            },
            {
                memcmp: {
                    offset: 0,
                    bytes: ticketIdlEntry.discriminator,
                }
            }
        ]
    });

    if (accounts.length === 0) {
        console.log("No legacy UnbondingTicket accounts found — migration complete.");
        return;
    }

    console.log(`Found ${accounts.length} legacy UnbondingTicket account(s).`);
    console.log("These can be closed by calling redeem with the ticket PDA (rent will be returned to the owner).");
    console.log("-".repeat(60));

    const coder = new anchor.BorshAccountsCoder(program.idl);
    const unbondingRequests = accounts.map(({ pubkey, account }) => {
        try {
            const decoded = coder.decode("unbondingTicket", account.data);
            return {
                pubkey,
                owner: decoded.owner,
                requestedAmount: decoded.requestedAmount,
                startBalance: decoded.startBalance,
                startTime: decoded.startTs
            };
        } catch (e) {
            console.error("Failed to decode account:", pubkey.toBase58(), e);
            return null;
        }
    }).filter(x => x !== null);

    unbondingRequests.forEach(r => {
        console.log(`Ticket PDA:       ${r.pubkey.toBase58()}`);
        console.log(`Owner:            ${r.owner.toBase58()}`);
        console.log(`Requested Amount: ${r.requestedAmount.toString()}`);
        console.log(`Start Balance:    ${r.startBalance.toString()}`);
        console.log(`Start Time:       ${new Date(r.startTime.toNumber() * 1000).toISOString()}`);
        console.log("-".repeat(60));
    });
};

main().catch(console.error);
