import * as anchor from "@coral-xyz/anchor";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";

const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);

// Replace with your actual values
const mint = new anchor.web3.PublicKey("9uvaKJ35VwvEL6EAbhAWtnLj3ieourfmMfzeVSWX7rNH");
const owner = new anchor.web3.PublicKey("3NRge7dn4WCa9zuAs6pXo8MzFs5E1xXhgzMBktF5LeW");

// Derive ATA (associated token account)
const main = async () => {
  const ata = getAssociatedTokenAddressSync(
    mint,
    owner,
    false // allowOwnerOffCurve (false = standard PDA only)
  );

  console.log("Associated Token Account:", ata.toBase58());
}

main();