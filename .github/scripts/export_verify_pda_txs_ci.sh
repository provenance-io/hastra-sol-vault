#!/bin/bash
# Export solana-verify PDA write transactions for devnet and mainnet (CI / release).
# Expects verify-config vars in the environment (see .github/verify-config.env).

set -euo pipefail

ARTIFACTS_DIR="${1:-artifacts}"
REPO_URL="${REPO_URL:-https://github.com/${GITHUB_REPOSITORY}}"
COMMIT_HASH="${COMMIT_HASH:-${GITHUB_SHA}}"

mkdir -p "${ARTIFACTS_DIR}"

export_cluster_pda_txs() {
  local cluster="$1"
  local rpc_url squads_vault mint_id stake_id mint_out stake_out

  case "${cluster}" in
    devnet)
      rpc_url="${DEVNET_RPC_URL}"
      squads_vault="${DEVNET_SQUADS_VAULT}"
      mint_id="${DEVNET_VAULT_MINT_PROGRAM_ID}"
      stake_id="${DEVNET_VAULT_STAKE_PROGRAM_ID}"
      mint_out="${ARTIFACTS_DIR}/pda-tx-devnet-vault_mint.txt"
      stake_out="${ARTIFACTS_DIR}/pda-tx-devnet-vault_stake.txt"
      ;;
    mainnet)
      rpc_url="${MAINNET_RPC_URL}"
      squads_vault="${MAINNET_SQUADS_VAULT}"
      mint_id="${MAINNET_VAULT_MINT_PROGRAM_ID}"
      stake_id="${MAINNET_VAULT_STAKE_PROGRAM_ID}"
      mint_out="${ARTIFACTS_DIR}/pda-tx-mainnet-vault_mint.txt"
      stake_out="${ARTIFACTS_DIR}/pda-tx-mainnet-vault_stake.txt"
      ;;
    *)
      echo "ERROR: Unknown cluster: ${cluster}"
      exit 1
      ;;
  esac

  echo "Exporting verify PDA txs (${cluster})..."
  echo "  uploader (Squads vault / upgrade authority): ${squads_vault}"

  solana-verify export-pda-tx "${REPO_URL}" \
    --library-name vault_mint \
    --program-id "${mint_id}" \
    --uploader "${squads_vault}" \
    --commit-hash "${COMMIT_HASH}" \
    --encoding base58 \
    --url "${rpc_url}" \
    --compute-unit-price 0 \
    > "${mint_out}"

  solana-verify export-pda-tx "${REPO_URL}" \
    --library-name vault_stake \
    --program-id "${stake_id}" \
    --uploader "${squads_vault}" \
    --commit-hash "${COMMIT_HASH}" \
    --encoding base58 \
    --url "${rpc_url}" \
    --compute-unit-price 0 \
    > "${stake_out}"

  echo "  ${mint_out}: $(wc -c < "${mint_out}" | tr -d ' ') bytes"
  echo "  ${stake_out}: $(wc -c < "${stake_out}" | tr -d ' ') bytes"
}

export_cluster_pda_txs devnet
export_cluster_pda_txs mainnet
