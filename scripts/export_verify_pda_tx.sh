#!/bin/bash
# export_verify_pda_tx.sh — Export solana-verify PDA write transactions for Squads v4.
#
# Usage (from repo root):
#   ./scripts/export_verify_pda_tx.sh both
#   ./scripts/export_verify_pda_tx.sh both mainnet
#   ./scripts/export_verify_pda_tx.sh mint devnet
#   ./scripts/export_verify_pda_tx.sh show /path/to/downloaded/artifacts
#   ./scripts/export_verify_pda_tx.sh to-msg /path/to/verify/pda-tx-*.txt
#
# Cluster defaults to devnet. Values: devnet | mainnet (mainnet-beta).
# Requires: solana-verify on PATH, git, .github/verify-config.env
# to-msg also requires yarn install (bs58) and Node.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
VERIFY_CONFIG="${REPO_ROOT}/.github/verify-config.env"
OUTPUT_DIR="${VERIFY_ARTIFACTS_DIR:-${REPO_ROOT}/verify-artifacts/verify}"
PDA_TX_TO_MSG="${REPO_ROOT}/.github/scripts/pda_tx_to_msg.mjs"

usage() {
  echo "Usage: $0 {mint|stake|both|show <dir>|to-msg <pda-tx-file>} [devnet|mainnet]"
  echo ""
  echo "  mint|stake|both  Run solana-verify export-pda-tx into ${OUTPUT_DIR}/"
  echo "  show <dir>       List pda-tx-* / pda-msg-* from a CI download or release"
  echo "  to-msg <file>    Convert a pda-tx-*.txt full tx into sibling pda-msg-*.txt"
  echo ""
  echo "  Second argument selects cluster for mint|stake|both (default: devnet)."
  exit 1
}

load_verify_config() {
  if [ ! -f "$VERIFY_CONFIG" ]; then
    echo "ERROR: Missing ${VERIFY_CONFIG}"
    exit 1
  fi
  # shellcheck source=/dev/null
  source "$VERIFY_CONFIG"
}

normalize_cluster() {
  local cluster="${1:-devnet}"
  case "$cluster" in
    devnet) echo devnet ;;
    mainnet|mainnet-beta) echo mainnet ;;
    *)
      echo "ERROR: Unknown cluster: $cluster (use devnet or mainnet)"
      exit 1
      ;;
  esac
}

resolve_cluster_env() {
  local cluster="$1"
  case "$cluster" in
    devnet)
      VERIFY_CLUSTER_LABEL=devnet
      VERIFY_RPC_URL="${DEVNET_RPC_URL}"
      VERIFY_SQUADS_VAULT="${DEVNET_SQUADS_VAULT}"
      VERIFY_MINT_PROGRAM_ID="${DEVNET_VAULT_MINT_PROGRAM_ID}"
      VERIFY_STAKE_PROGRAM_ID="${DEVNET_VAULT_STAKE_PROGRAM_ID}"
      VERIFY_PDA_SUFFIX="-devnet"
      ;;
    mainnet)
      VERIFY_CLUSTER_LABEL=mainnet
      VERIFY_RPC_URL="${MAINNET_RPC_URL}"
      VERIFY_SQUADS_VAULT="${MAINNET_SQUADS_VAULT}"
      VERIFY_MINT_PROGRAM_ID="${MAINNET_VAULT_MINT_PROGRAM_ID}"
      VERIFY_STAKE_PROGRAM_ID="${MAINNET_VAULT_STAKE_PROGRAM_ID}"
      VERIFY_PDA_SUFFIX="-mainnet"
      ;;
  esac
}

git_https_repo_url() {
  local remote url
  remote=$(git -C "$REPO_ROOT" remote get-url origin 2>/dev/null || true)
  if [ -z "$remote" ]; then
    echo "ERROR: No git remote 'origin' in ${REPO_ROOT}"
    exit 1
  fi
  if [[ "$remote" =~ ^git@github\.com:(.+)\.git$ ]]; then
    url="https://github.com/${BASH_REMATCH[1]}"
  elif [[ "$remote" =~ ^https://github\.com/(.+)(\.git)?$ ]]; then
    url="https://github.com/${BASH_REMATCH[1]%.git}"
  else
    echo "ERROR: Unsupported remote URL: $remote"
    exit 1
  fi
  echo "$url"
}

warn_if_dirty_tree() {
  if ! git -C "$REPO_ROOT" diff --quiet || ! git -C "$REPO_ROOT" diff --cached --quiet; then
    echo "WARNING: Working tree has uncommitted changes; PDA commit hash may not match CI."
  fi
}

require_solana_verify() {
  if ! command -v solana-verify >/dev/null 2>&1; then
    echo "ERROR: solana-verify not found. Install: cargo install solana-verify"
    exit 1
  fi
}

# Extract the last base58 line from solana-verify stdout and write a clean file.
write_clean_pda_tx_from_cmd() {
  local outfile="$1"
  shift
  local tmp status=0
  tmp="$(mktemp)"
  "$@" >"${tmp}" || status=$?

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
    echo "ERROR: solana-verify export-pda-tx failed (exit ${status})" >&2
    exit 1
  fi
  if [ -z "${b58}" ]; then
    echo "ERROR: No base58 transaction produced" >&2
    exit 1
  fi

  printf '%s\n' "${b58}" > "${outfile}"
}

export_pda_tx() {
  local library_label="$1"
  local program_id="$2"
  local outfile="${OUTPUT_DIR}/pda-tx${VERIFY_PDA_SUFFIX}-${library_label}.txt"

  mkdir -p "$OUTPUT_DIR"
  local repo_url commit
  repo_url=$(git_https_repo_url)
  commit=$(git -C "$REPO_ROOT" rev-parse HEAD)

  echo "Exporting verify PDA tx for ${library_label} (${VERIFY_CLUSTER_LABEL})..."
  echo "  program-id: ${program_id}"
  echo "  uploader:   ${VERIFY_SQUADS_VAULT}"
  echo "  rpc:        ${VERIFY_RPC_URL}"
  echo "  commit:     ${commit}"
  echo "  output:     ${outfile}"

  write_clean_pda_tx_from_cmd "${outfile}" \
    solana-verify export-pda-tx "${repo_url}" \
      --library-name "${library_label}" \
      --program-id "${program_id}" \
      --uploader "${VERIFY_SQUADS_VAULT}" \
      --commit-hash "${commit}" \
      --encoding base58 \
      --url "${VERIFY_RPC_URL}" \
      --compute-unit-price 0

  echo "  wrote $(wc -c < "${outfile}" | tr -d ' ') bytes (clean base58)"
  node "${PDA_TX_TO_MSG}" "${outfile}" --write >/dev/null
}

print_squads_instructions() {
  local squads_app="https://backup.app.squads.so"
  if [ "${VERIFY_CLUSTER_LABEL}" = "mainnet" ]; then
    squads_app="https://app.squads.so"
  fi

  echo ""
  echo "============================================================"
  echo "  Squads v4 — verify PDA transaction (${VERIFY_CLUSTER_LABEL})"
  echo "============================================================"
  echo "  Vault / uploader:     ${VERIFY_SQUADS_VAULT}"
  if [ "${VERIFY_CLUSTER_LABEL}" = "mainnet" ]; then
    echo "  Multisig (proposals): ${MAINNET_SQUADS_MULTISIG}"
    echo "  Squads program:       ${MAINNET_SQUADS_PROGRAM_ID}"
  fi
  echo ""
  echo "  1. Execute the program upgrade proposal first."
  echo "  2. Open ${squads_app} → Transaction Builder → Import transaction."
  echo "  3. Paste base58 from the message-only files:"
  echo "       pda-msg${VERIFY_PDA_SUFFIX}-vault_mint.txt"
  echo "       pda-msg${VERIFY_PDA_SUFFIX}-vault_stake.txt"
  echo "  4. Simulate: only otter verify (+ compute budget if present)."
  echo "  5. After execution, per program:"
  echo "       solana-verify remote submit-job \\"
  echo "         --program-id <PROGRAM_ID> \\"
  echo "         --uploader ${VERIFY_SQUADS_VAULT}"
  echo "============================================================"
  echo ""
}

resolve_verify_listing_dir() {
  local dir="$1"
  if [ -d "${dir}/verify" ]; then
    echo "${dir}/verify"
  else
    echo "${dir}"
  fi
}

show_pda_tx_dir() {
  local dir="$1"
  if [ ! -d "$dir" ]; then
    echo "ERROR: Directory not found: $dir"
    exit 1
  fi
  local list_dir
  list_dir="$(resolve_verify_listing_dir "$dir")"
  echo "Verify PDA files in ${list_dir}:"
  shopt -s nullglob
  local files=("${list_dir}"/pda-tx*.txt "${list_dir}"/pda-msg*.txt)
  shopt -u nullglob
  if [ ${#files[@]} -eq 0 ]; then
    echo "  (no pda-tx* / pda-msg* files)"
    return
  fi
  # Sort for stable output
  local f
  while IFS= read -r f; do
    echo "  $(basename "$f") ($(wc -c < "$f" | tr -d ' ') bytes)"
  done < <(printf '%s\n' "${files[@]}" | sort)
}

to_msg_file() {
  local file="$1"
  if [ ! -f "$file" ]; then
    echo "ERROR: File not found: $file"
    exit 1
  fi
  node "${PDA_TX_TO_MSG}" "$file" --write
}

main() {
  [ $# -ge 1 ] || usage
  case "$1" in
    show)
      [ $# -eq 2 ] || usage
      show_pda_tx_dir "$2"
      ;;
    to-msg)
      [ $# -eq 2 ] || usage
      to_msg_file "$2"
      ;;
    mint|stake|both)
      local cluster
      cluster=$(normalize_cluster "${2:-devnet}")
      load_verify_config
      resolve_cluster_env "$cluster"
      require_solana_verify
      warn_if_dirty_tree
      case "$1" in
        mint)
          export_pda_tx "vault_mint" "${VERIFY_MINT_PROGRAM_ID}"
          ;;
        stake)
          export_pda_tx "vault_stake" "${VERIFY_STAKE_PROGRAM_ID}"
          ;;
        both)
          export_pda_tx "vault_mint" "${VERIFY_MINT_PROGRAM_ID}"
          export_pda_tx "vault_stake" "${VERIFY_STAKE_PROGRAM_ID}"
          ;;
      esac
      print_squads_instructions
      ;;
    *)
      usage
      ;;
  esac
}

main "$@"
