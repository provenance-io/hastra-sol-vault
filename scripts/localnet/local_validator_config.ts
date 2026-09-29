/**
 * Helpers for scripts/.local-validator/config.json produced by initialize-local-validator.ts.
 * Used by localnet-only tooling so operators do not need separate keypair files.
 */

import * as fs from "fs";
import * as path from "path";
import {Keypair} from "@solana/web3.js";
import bs58 from "bs58";

export interface ConfigKeypairEntry {
    publicKey: string;
    secretKey: string;
}

export interface LocalValidatorConfigJson {
    network?: string;
    rpcUrl?: string;
    timestamp?: string;
    upgradeAuthority: ConfigKeypairEntry;
    rewardsAdmin: ConfigKeypairEntry;
    freezeAdmin: ConfigKeypairEntry;
    tokens?: Record<string, string>;
    mintProgram?: Record<string, string>;
    stakeProgram?: Record<string, string>;
    stakeAutoProgram?: Record<string, string>;
}

export function defaultLocalValidatorConfigPath(): string {
    return path.join(__dirname, "..", ".local-validator", "config.json");
}

export function defaultLocalValidatorEnvPath(): string {
    return path.join(__dirname, "..", ".local-validator", ".env");
}

export function readLocalValidatorConfig(
    configPath: string = defaultLocalValidatorConfigPath()
): LocalValidatorConfigJson {
    const raw = fs.readFileSync(configPath, "utf8");
    return JSON.parse(raw) as LocalValidatorConfigJson;
}

/**
 * Decode a base58 secret from config.json into a Solana keypair.
 */
export function keypairFromConfigSecret(secretKeyBase58: string): Keypair {
    const raw = Buffer.from(bs58.decode(secretKeyBase58));
    if (raw.length === 64) {
        return Keypair.fromSecretKey(raw);
    }
    if (raw.length === 32) {
        return Keypair.fromSeed(raw);
    }
    throw new Error(`Unexpected secret key length: ${raw.length}`);
}

/**
 * Load KEY=value lines from a .env-style file (no bash export syntax).
 */
export function loadEnvFile(filePath: string): Record<string, string> {
    if (!fs.existsSync(filePath)) {
        return {};
    }
    const out: Record<string, string> = {};
    for (const line of fs.readFileSync(filePath, "utf8").split("\n")) {
        const t = line.trim();
        if (!t || t.startsWith("#")) {
            continue;
        }
        const eq = t.indexOf("=");
        if (eq <= 0) {
            continue;
        }
        const key = t.slice(0, eq).trim();
        let val = t.slice(eq + 1).trim();
        if (
            (val.startsWith('"') && val.endsWith('"')) ||
            (val.startsWith("'") && val.endsWith("'"))
        ) {
            val = val.slice(1, -1);
        }
        out[key] = val;
    }
    return out;
}
