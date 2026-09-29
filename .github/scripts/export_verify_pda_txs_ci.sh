#!/bin/bash
# Export solana-verify PDA write transactions for devnet and mainnet (CI / release).
# Writes clean base58 into artifacts/verify/ (no log lines) plus Squads message-only
# pda-msg-*.txt siblings. Expects verify-config vars in the environment
# (see .github/verify-config.env).

set -euo pipefail

ARTIFACTS_DIR="${1:-artifacts}"
VERIFY_DIR="${ARTIFACTS_DIR}/verify"
REPO_URL="${REPO_URL:-https://github.com/${GITHUB_REPOSITORY}}"
COMMIT_HASH="${COMMIT_HASH:-${GITHUB_SHA}}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
PDA_TX_TO_MSG="${SCRIPT_DIR}/pda_tx_to_msg.mjs"

mkdir -p "${VERIFY_DIR}"

# Run export-pda-tx; echo tool progress to CI logs; write only the base58 line to outfile.
write_clean_pda_tx() {
  local outfile="$1"
  shift
  local tmp status=0
  tmp="$(mktemp)"
  # solana-verify prints progress and the final base58 line on stdout.
  solana-verify export-pda-tx "$@" >"${tmp}" || status=$?

  local b58=""
  local line
  while IFS= read -r line || [ -n "${line}" ]; do
    line="${line%"${line##*[![:space:]]}"}"
    if [[ "${line}" =~ ^[1-9A-HJ-NP-Za-km-z]{80,}$ ]]; then
      b58="${line}"
    elif [ -n "${line}" ]; then
      echo "${line}" >&2
    fi
  done < "${tmp}"
  rm -f "${tmp}"

  if [ "${status}" -ne 0 ]; then
    echo "ERROR: solana-verify export-pda-tx failed for ${outfile} (exit ${status})" >&2
    exit 1
  fi
  if [ -z "${b58}" ]; then
    echo "ERROR: No base58 transaction produced for ${outfile}" >&2
    exit 1
  fi

  printf '%s\n' "${b58}" > "${outfile}"
  echo "  ${outfile}: $(wc -c < "${outfile}" | tr -d ' ') bytes" >&2

  node "${PDA_TX_TO_MSG}" "${outfile}" --write >/dev/null
}

export_stake_pda_tx() {
  local rpc_url="$1"
  local squads_vault="$2"
  local program_id="$3"
  local output_file="$4"
  shift 4
  local -a extra_args=("$@")

  write_clean_pda_tx "${output_file}" \
    "${REPO_URL}" \
    --library-name vault_stake \
    --program-id "${program_id}" \
    --uploader "${squads_vault}" \
    --commit-hash "${COMMIT_HASH}" \
    --encoding base58 \
    --url "${rpc_url}" \
    --compute-unit-price 0 \
    "${extra_args[@]}"
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
      mint_out="${VERIFY_DIR}/pda-tx-devnet-vault_mint.txt"
      stake_prime_out="${VERIFY_DIR}/pda-tx-devnet-vault_stake_prime.txt"
      stake_auto_out="${VERIFY_DIR}/pda-tx-devnet-vault_stake_auto.txt"
      stake_smb_out="${VERIFY_DIR}/pda-tx-devnet-vault_stake_smb.txt"
      ;;
    mainnet)
      rpc_url="${MAINNET_RPC_URL}"
      squads_vault="${MAINNET_SQUADS_VAULT}"
      mint_id="${MAINNET_VAULT_MINT_PROGRAM_ID}"
      stake_prime_id="${MAINNET_VAULT_STAKE_PROGRAM_ID}"
      stake_auto_id="${MAINNET_VAULT_STAKE_AUTO_PROGRAM_ID}"
      stake_smb_id="${MAINNET_VAULT_STAKE_SMB_PROGRAM_ID}"
      auto_build_args=(-- --no-default-features --features pool-auto)
      mint_out="${VERIFY_DIR}/pda-tx-mainnet-vault_mint.txt"
      stake_prime_out="${VERIFY_DIR}/pda-tx-mainnet-vault_stake_prime.txt"
      stake_auto_out="${VERIFY_DIR}/pda-tx-mainnet-vault_stake_auto.txt"
      stake_smb_out="${VERIFY_DIR}/pda-tx-mainnet-vault_stake_smb.txt"
      ;;
    *)
      echo "ERROR: Unknown cluster: ${cluster}" >&2
      exit 1
      ;;
  esac

  echo "Exporting verify PDA txs (${cluster})..." >&2
  echo "  uploader (Squads vault / upgrade authority): ${squads_vault}" >&2
  echo "  repo: ${REPO_URL}" >&2
  echo "  commit: ${COMMIT_HASH}" >&2
  echo "  repo root (for node_modules/bs58): ${REPO_ROOT}" >&2

  write_clean_pda_tx "${mint_out}" \
    "${REPO_URL}" \
    --library-name vault_mint \
    --program-id "${mint_id}" \
    --uploader "${squads_vault}" \
    --commit-hash "${COMMIT_HASH}" \
    --encoding base58 \
    --url "${rpc_url}" \
    --compute-unit-price 0

  export_stake_pda_tx "${rpc_url}" "${squads_vault}" "${stake_prime_id}" "${stake_prime_out}"
  export_stake_pda_tx "${rpc_url}" "${squads_vault}" "${stake_auto_id}" "${stake_auto_out}" "${auto_build_args[@]}"
  export_stake_pda_tx "${rpc_url}" "${squads_vault}" "${stake_smb_id}" "${stake_smb_out}" \
    -- --no-default-features --features pool-smb
}

# Ensure bs58 resolves from the workspace install.
cd "${REPO_ROOT}"

export_cluster_pda_txs devnet
export_cluster_pda_txs mainnet
