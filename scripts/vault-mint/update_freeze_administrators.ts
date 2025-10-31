import * as anchor from "@coral-xyz/anchor";
import {Program} from "@coral-xyz/anchor";
import {VaultMint} from "../../target/types/vault_mint";
import {PublicKey} from "@solana/web3.js";
import yargs from "yargs";

const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);

const program = anchor.workspace.VaultMint as Program<VaultMint>;

const args = yargs(process.argv.slice(2))
    .option("freeze_administrators", {
        type: "string",
        description: "Comma separated list of administrator public keys that can freeze user accounts",
        required: true,
    })
    .parseSync();

const main = async () => {
    const freezeAdministrators: PublicKey[] = (args.freeze_administrators.split(",")).map((s: string) => new anchor.web3.PublicKey(s));
    if(freezeAdministrators.length > 5) {
        throw new Error(`Number of freeze administrators (${freezeAdministrators.length}) exceeds maximum 5`);
    }

    const [configPda, bump] = PublicKey.findProgramAddressSync([
        Buffer.from("config")
    ], program.programId);

    // bpf_loader_upgradeable program id
    const BPF_LOADER_UPGRADEABLE_ID = new PublicKey(
        "BPFLoaderUpgradeab1e11111111111111111111111"
    );
    // derive ProgramData PDA
    const [programData] = PublicKey.findProgramAddressSync(
        [program.programId.toBuffer()],
        BPF_LOADER_UPGRADEABLE_ID
    );

    const mint = new PublicKey(args.mint);
    const newAuthority = new PublicKey(args.new_authority);
    console.log("Config PDA:", configPda.toBase58());
    console.log("ProgramData PDA:", programData.toBase58());
    console.log("Freeze Administrators:", freezeAdministrators.map((a) => a.toBase58()));

    const tx = await program.methods
        .updateFreezeAdministrators(freezeAdministrators)
        .accountsStrict({
            config: configPda,
            signer: provider.wallet.publicKey,
            programData: programData,
        })
        .rpc();

    console.log("Transaction:", tx);
};

main().catch(console.error); 
