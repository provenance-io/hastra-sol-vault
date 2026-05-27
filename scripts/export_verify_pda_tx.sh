#!/bin/bash
# export_verify_pda_tx.sh — Export solana-verify PDA write transactions for Squads v4.
#
# Usage (from repo root):
#   ./scripts/export_verify_pda_tx.sh both
#   ./scripts/export_verify_pda_tx.sh mint
#   ./scripts/export_verify_pda_tx.sh stake
#   ./scripts/export_verify_pda_tx.sh show /path/to/downloaded/artifacts
#
# Requires: solana-verify on PATH, git, devnet values in .github/verify-config.env

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
VERIFY_CONFIG="${REPO_ROOT}/.github/verify-config.env"
OUTPUT_DIR="${VERIFY_ARTIFACTS_DIR:-${REPO_ROOT}/verify-artifacts}"

usage() {
  echo "Usage: $0 {mint|stake|both|show <dir>}"
  echo ""
  echo "  mint|stake|both  Run solana-verify export-pda-tx into ${OUTPUT_DIR}/"
  echo "  show <dir>       Print paths and first bytes of pda-tx-*.txt from a CI download"
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

export_pda_tx() {
  local library_label="$1"
  local program_id="$2"
  local outfile="${OUTPUT_DIR}/pda-tx-${library_label}.txt"

  mkdir -p "$OUTPUT_DIR"
  local repo_url commit
  repo_url=$(git_https_repo_url)
  commit=$(git -C "$REPO_ROOT" rev-parse HEAD)

  echo "Exporting verify PDA tx for ${library_label}..."
  echo "  program-id: ${program_id}"
  echo "  uploader:   ${DEVNET_SQUADS_VAULT}"
  echo "  commit:     ${commit}"
  echo "  output:     ${outfile}"

  solana-verify export-pda-tx "${repo_url}" \
    --program-id "${program_id}" \
    --uploader "${DEVNET_SQUADS_VAULT}" \
    --commit-hash "${commit}" \
    --encoding base58 \
    --url "${DEVNET_RPC_URL}" \
    --compute-unit-price 0 \
    > "${outfile}"

  echo "  wrote $(wc -c < "${outfile}" | tr -d ' ') bytes"
}

print_squads_instructions() {
  echo ""
  echo "============================================================"
  echo "  Squads v4 — verify PDA transaction"
  echo "============================================================"
  echo "  1. Execute the program upgrade proposal first."
  echo "  2. Open Squads Transaction Builder → Import transaction."
  echo "  3. Paste base58 from pda-tx-vault_mint.txt / pda-tx-vault_stake.txt."
  echo "  4. Simulate: only otter verify + compute budget instructions."
  echo "  5. After execution, per program:"
  echo "       solana-verify remote submit-job \\"
  echo "         --program-id <PROGRAM_ID> \\"
  echo "         --uploader ${DEVNET_SQUADS_VAULT}"
  echo "============================================================"
  echo ""
}

show_pda_tx_dir() {
  local dir="$1"
  if [ ! -d "$dir" ]; then
    echo "ERROR: Directory not found: $dir"
    exit 1
  fi
  echo "Verify PDA files in ${dir}:"
  for f in "$dir"/pda-tx-vault_mint.txt "$dir"/pda-tx-vault_stake.txt; do
    if [ -f "$f" ]; then
      echo "  $(basename "$f") ($(wc -c < "$f" | tr -d ' ') bytes)"
    else
      echo "  $(basename "$f") (missing)"
    fi
  done
}

main() {
  [ $# -ge 1 ] || usage
  case "$1" in
    show)
      [ $# -eq 2 ] || usage
      show_pda_tx_dir "$2"
      ;;
    mint|stake|both)
      load_verify_config
      require_solana_verify
      warn_if_dirty_tree
      case "$1" in
        mint)
          export_pda_tx "vault_mint" "${DEVNET_VAULT_MINT_PROGRAM_ID}"
          ;;
        stake)
          export_pda_tx "vault_stake" "${DEVNET_VAULT_STAKE_PROGRAM_ID}"
          ;;
        both)
          export_pda_tx "vault_mint" "${DEVNET_VAULT_MINT_PROGRAM_ID}"
          export_pda_tx "vault_stake" "${DEVNET_VAULT_STAKE_PROGRAM_ID}"
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
