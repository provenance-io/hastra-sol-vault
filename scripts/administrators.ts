import { PublicKey } from "@solana/web3.js";

export const MAX_ADMINISTRATORS = 5;

/** Parses a comma-separated administrator list: 1–5 unique public keys. */
export function parseAdministrators(csv: string, label: string): PublicKey[] {
    const keys = csv
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
        .map((s) => new PublicKey(s));
    if (keys.length === 0) {
        throw new Error(`${label} must contain at least one public key`);
    }
    if (keys.length > MAX_ADMINISTRATORS) {
        throw new Error(`${label} length (${keys.length}) exceeds maximum ${MAX_ADMINISTRATORS}`);
    }
    for (let i = 0; i < keys.length; i++) {
        if (keys.slice(0, i).some((k) => k.equals(keys[i]))) {
            throw new Error(`${label} contains duplicate key: ${keys[i].toBase58()}`);
        }
    }
    return keys;
}
