#!/bin/bash
# Export solana-verify PDA write transactions for devnet and mainnet (CI / release).
# Expects verify-config vars in the environment (see .github/verify-config.env).

set -euo pipefail

ARTIFACTS_DIR="${1:-artifacts}"
REPO_URL="${REPO_URL:-https://github.com/${GITHUB_REPOSITORY}}"
COMMIT_HASH="${COMMIT_HASH:-${GITHUB_SHA}}"

mkdir -p "${ARTIFACTS_DIR}"

export_stake_pda_tx() {
  local rpc_url="$1"
  local squads_vault="$2"
  local program_id="$3"
  local output_file="$4"
  shift 4
  local -a extra_args=("$@")

  solana-verify export-pda-tx "${REPO_URL}" \
    --library-name vault_stake \
    --program-id "${program_id}" \
    --uploader "${squads_vault}" \
    --commit-hash "${COMMIT_HASH}" \
    --encoding base58 \
    --url "${rpc_url}" \
    --compute-unit-price 0 \
    "${extra_args[@]}" \
    > "${output_file}"

  echo "  ${output_file}: $(wc -c < "${output_file}" | tr -d ' ') bytes"
}

export_cluster_pda_txs() {
  local cluster="$1"
  local rpc_url squads_vault mint_id
  local stake_prime_id stake_auto_id stake_smb_id
  local mint_out stake_prime_out stake_auto_out stake_smb_out
  local -a auto_build_args=()

  case "${cluster}" in
    devnet)
      rpc_url="${DEVNET_RPC_URL}"
      squads_vault="${DEVNET_SQUADS_VAULT}"
      mint_id="${DEVNET_VAULT_MINT_PROGRAM_ID}"
      stake_prime_id="${DEVNET_VAULT_STAKE_PROGRAM_ID}"
      stake_auto_id="${DEVNET_VAULT_STAKE_AUTO_PROGRAM_ID}"
      stake_smb_id="${DEVNET_VAULT_STAKE_SMB_PROGRAM_ID}"
      auto_build_args=(-- --no-default-features --features pool-auto-devnet)
      mint_out="${ARTIFACTS_DIR}/pda-tx-devnet-vault_mint.txt"
      stake_prime_out="${ARTIFACTS_DIR}/pda-tx-devnet-vault_stake_prime.txt"
      stake_auto_out="${ARTIFACTS_DIR}/pda-tx-devnet-vault_stake_auto.txt"
      stake_smb_out="${ARTIFACTS_DIR}/pda-tx-devnet-vault_stake_smb.txt"
      ;;
    mainnet)
      rpc_url="${MAINNET_RPC_URL}"
      squads_vault="${MAINNET_SQUADS_VAULT}"
      mint_id="${MAINNET_VAULT_MINT_PROGRAM_ID}"
      stake_prime_id="${MAINNET_VAULT_STAKE_PROGRAM_ID}"
      stake_auto_id="${MAINNET_VAULT_STAKE_AUTO_PROGRAM_ID}"
      stake_smb_id="${MAINNET_VAULT_STAKE_SMB_PROGRAM_ID}"
      auto_build_args=(-- --no-default-features --features pool-auto)
      mint_out="${ARTIFACTS_DIR}/pda-tx-mainnet-vault_mint.txt"
      stake_prime_out="${ARTIFACTS_DIR}/pda-tx-mainnet-vault_stake_prime.txt"
      stake_auto_out="${ARTIFACTS_DIR}/pda-tx-mainnet-vault_stake_auto.txt"
      stake_smb_out="${ARTIFACTS_DIR}/pda-tx-mainnet-vault_stake_smb.txt"
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

  echo "  ${mint_out}: $(wc -c < "${mint_out}" | tr -d ' ') bytes"

  export_stake_pda_tx "${rpc_url}" "${squads_vault}" "${stake_prime_id}" "${stake_prime_out}"
  export_stake_pda_tx "${rpc_url}" "${squads_vault}" "${stake_auto_id}" "${stake_auto_out}" "${auto_build_args[@]}"
  export_stake_pda_tx "${rpc_url}" "${squads_vault}" "${stake_smb_id}" "${stake_smb_out}" \
    -- --no-default-features --features pool-smb
}

export_cluster_pda_txs devnet
export_cluster_pda_txs mainnet
