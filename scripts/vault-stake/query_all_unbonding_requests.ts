import * as anchor from "@coral-xyz/anchor";
import {Program} from "@coral-xyz/anchor";
import {VaultStake} from "../../target/types/vault_stake";
import {STAKE_IDL} from "../cryptolib";

const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);

const program = anchor.workspace.VaultStake as Program<VaultStake>;

const main = async () => {
    const accounts = await provider.connection.getProgramAccounts(program.programId, {
        filters: [
            {
                // Filter by account size (UnbondingTicket::LEN)
                dataSize: 8 + 32 + 8 + 8 + 8,
            },
            // filter by discriminator to only get UnbondingTicket accounts
            {
                memcmp: {
                    offset: 0,
                    bytes: STAKE_IDL.accounts.filter(a => a.name === "UnbondingTicket")[0].discriminator
                }
            }
        ]
    });
    const coder = new anchor.BorshAccountsCoder(program.idl);
    const unbondingRequests = accounts.map(({ pubkey, account }) => {
        try {
            const decoded = coder.decode("unbondingTicket", account.data);
            return {
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

    console.log("-".repeat(60));
    unbondingRequests.forEach(r => {
        console.log(`Owner:           ${r.owner.toBase58()}`);
        console.log(`Requested Amount:${r.requestedAmount.toString()}`);
        console.log(`Start Balance:   ${r.startBalance.toString()}`);
        console.log(`Start Time:      ${new Date(r.startTime.toNumber() * 1000).toISOString()}`);
    })
    console.log("-".repeat(60));


}

main().catch(console.error);
