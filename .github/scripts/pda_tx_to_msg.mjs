#!/usr/bin/env node
/**
 * Convert a solana-verify export-pda-tx base58 transaction into a message-only
 * base58 blob for Squads Transaction Builder (backup.app.squads.so).
 *
 * Usage:
 *   node .github/scripts/pda_tx_to_msg.mjs <pda-tx-*.txt>
 *   node .github/scripts/pda_tx_to_msg.mjs <pda-tx-*.txt> --write
 *   echo '<base58-tx>' | node .github/scripts/pda_tx_to_msg.mjs -
 *
 * --write writes a sibling pda-msg-*.txt next to the input file.
 */
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(fileURLToPath(import.meta.url));

function loadBs58() {
  // Prefer repo-root node_modules (CI / local), then cwd.
  const candidates = [
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../node_modules/bs58"),
    "bs58",
  ];
  for (const id of candidates) {
    try {
      const mod = require(id);
      return mod.default ?? mod;
    } catch {
      // try next
    }
  }
  throw new Error("bs58 not found; run yarn install from the repo root");
}

const bs58 = loadBs58();

function extractBase58(text) {
  const lines = text
    .trim()
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^[1-9A-HJ-NP-Za-km-z]{80,}$/.test(lines[i])) {
      return lines[i];
    }
  }
  throw new Error("No base58 transaction line found in input");
}

function txBase58ToMsgBase58(txB58) {
  const raw = Buffer.from(bs58.decode(txB58));
  if (raw.length < 66) {
    throw new Error(`Transaction too short (${raw.length} bytes)`);
  }
  const sigCount = raw[0];
  const msgStart = 1 + 64 * sigCount;
  if (msgStart >= raw.length) {
    throw new Error(`Invalid signature count ${sigCount} for ${raw.length}-byte payload`);
  }
  return bs58.encode(raw.subarray(msgStart));
}

function msgOutPath(txPath) {
  const dir = path.dirname(txPath);
  const base = path.basename(txPath);
  const msgBase = base.replace(/^pda-tx-/, "pda-msg-");
  if (msgBase === base) {
    throw new Error(`Input filename must start with pda-tx-: ${base}`);
  }
  return path.join(dir, msgBase);
}

function main() {
  const args = process.argv.slice(2).filter((a) => a !== "--write");
  const write = process.argv.includes("--write");
  const input = args[0];
  if (!input) {
    console.error(
      "Usage: node pda_tx_to_msg.mjs <pda-tx-*.txt|-> [--write]"
    );
    process.exit(1);
  }

  let text;
  if (input === "-") {
    text = fs.readFileSync(0, "utf8");
  } else {
    text = fs.readFileSync(input, "utf8");
  }

  const msgB58 = txBase58ToMsgBase58(extractBase58(text));

  if (write) {
    if (input === "-") {
      console.error("--write requires a file path input");
      process.exit(1);
    }
    const out = msgOutPath(input);
    fs.writeFileSync(out, `${msgB58}\n`, "utf8");
    console.error(`wrote ${out} (${msgB58.length} chars)`);
  }

  process.stdout.write(`${msgB58}\n`);
}

main();
