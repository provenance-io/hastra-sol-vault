#!/usr/bin/env bash
# Start solana-test-validator with the built workspace programs loaded at their
# production program IDs, so localnet runs the same IDs that ship.
#
# Programs are loaded as upgradeable with the local wallet as upgrade authority
# (initialize and the *_for_testing instructions check it). Build first, e.g.
#   mkdir -p target/deploy && anchor build -- --features testing
#
# Usage: scripts/localnet-validator.sh [extra solana-test-validator args...]
#   e.g. scripts/localnet-validator.sh --reset --ledger .anchor/test-ledger
# Env: ANCHOR_WALLET  upgrade authority keypair (default: Anchor.toml provider wallet)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEPLOY_DIR="${ROOT}/target/deploy"
WALLET="${ANCHOR_WALLET:-${HOME}/.config/solana/hastra-localnet-id.json}"

# "<library name> <program id>" for each entry in Anchor.toml [programs.localnet].
mapfile -t PROGRAMS < <(awk '
  /^\[/ { in_section = ($0 == "[programs.localnet]"); next }
  in_section && /=/ && !/^#/ {
    gsub(/[" ]/, "")
    split($0, kv, "=")
    gsub(/-/, "_", kv[1])
    print kv[1], kv[2]
  }
' "${ROOT}/Anchor.toml")

if [[ ${#PROGRAMS[@]} -eq 0 ]]; then
  echo "localnet-validator: no [programs.localnet] entries in Anchor.toml" >&2
  exit 1
fi

if [[ ! -f "${WALLET}" ]]; then
  echo "localnet-validator: wallet keypair not found: ${WALLET}" >&2
  echo "  create it with: solana-keygen new --no-passphrase --outfile ${WALLET}" >&2
  exit 1
fi
AUTHORITY="$(solana-keygen pubkey "${WALLET}")"

args=()
for entry in "${PROGRAMS[@]}"; do
  read -r lib id <<<"${entry}"
  so="${DEPLOY_DIR}/${lib}.so"
  if [[ ! -f "${so}" ]]; then
    echo "localnet-validator: ${so} not found; build the programs first" >&2
    exit 1
  fi
  args+=(--upgradeable-program "${id}" "${so}" "${AUTHORITY}")
done

exec solana-test-validator "${args[@]}" "$@"
