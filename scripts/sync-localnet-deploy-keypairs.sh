#!/usr/bin/env bash
# Copy committed localnet program keypairs into target/deploy for anchor build/test.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="${ROOT}/keys/localnet"
DEST="${ROOT}/target/deploy"

mkdir -p "${DEST}"
cp "${SRC}/vault_mint-keypair.json" "${DEST}/vault_mint-keypair.json"
cp "${SRC}/vault_stake-keypair.json" "${DEST}/vault_stake-keypair.json"
