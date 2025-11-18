import * as anchor from "@coral-xyz/anchor";
import {Program} from "@coral-xyz/anchor";
import {VaultMint} from "../../target/types/vault_mint";
import {MINT_IDL} from "../cryptolib";

const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);

const program = anchor.workspace.VaultMint as Program<VaultMint>;

const main = async () => {
    const accounts = await provider.connection.getProgramAccounts(program.programId, {
        filters: [
            {
                // Filter by account size (RedemptionRequest::LEN)
                dataSize: 8 + 32 + 8 + 32 + 1, // discriminator + user + amount + mint + bump
            },
            // Optional: filter by discriminator to only get RedemptionRequest accounts
            {
                memcmp: {
                    offset: 0,
                    bytes: MINT_IDL.accounts.filter(a => a.name === "RedemptionRequest")[0].discriminator
                }
            }
        ]
    });
    console.log(accounts);
    const coder = new anchor.BorshAccountsCoder(program.idl);
    const redemptionRequests = accounts.map(({ pubkey, account }) => {
        try {
            const decoded = coder.decode("redemptionRequest", account.data);
            return {
                publicKey: pubkey,
                user: decoded.user,
                amount: decoded.amount,
                mint: decoded.mint,
                bump: decoded.bump
            };
        } catch (e) {
            console.error("Failed to decode account:", pubkey.toBase58(), e);
            return null;
        }
    }).filter(x => x !== null);

    console.log("-".repeat(60));
    redemptionRequests.forEach(r => {
     console.log(`Ticket: ${r.publicKey.toBase58()}`);
     console.log(`User:   ${r.user.toBase58()}`);
     console.log(`Mint:   ${r.mint.toBase58()}`);
     console.log(`Amount: ${r.amount.toString()}`);
     console.log("-".repeat(60));
    });

}

main().catch(console.error);
