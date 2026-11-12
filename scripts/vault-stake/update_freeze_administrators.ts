import * as anchor from "@coral-xyz/anchor";
import {Program} from "@coral-xyz/anchor";
import {VaultStake} from "../../target/types/vault_stake";
import {PublicKey} from "@solana/web3.js";
import yargs from "yargs";
import {parseAdministrators} from "../administrators";

const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);

const program = anchor.workspace.VaultStake as Program<VaultStake>;

const args = yargs(process.argv.slice(2))
    .option("freeze_administrators", {
        type: "string",
        description: "Comma separated list of administrator public keys that can freeze user accounts",
        required: true,
    })
    .parseSync();

const main = async () => {
    const freezeAdministrators = parseAdministrators(args.freeze_administrators, "freeze_administrators");

    const [stakeConfigPda, bump] = PublicKey.findProgramAddressSync([
        Buffer.from("stake_config")
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

    console.log("Stake Config PDA:", stakeConfigPda.toBase58());
    console.log("ProgramData PDA:", programData.toBase58());
    console.log("Freeze Administrators:", freezeAdministrators.map((a) => a.toBase58()));

    const tx = await program.methods
        .updateFreezeAdministrators(freezeAdministrators)
        .accountsStrict({
            stakeConfig: stakeConfigPda,
            signer: provider.wallet.publicKey,
            programData: programData,
        })
        .rpc();

    console.log("Transaction:", tx);
};

main().catch(console.error); 
