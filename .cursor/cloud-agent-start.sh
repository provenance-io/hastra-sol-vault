#!/usr/bin/env bash
set -euo pipefail

export PATH="/home/ubuntu/.local/share/solana/install/active_release/bin:/usr/local/cargo/bin:/usr/local/bin:${PATH}"

KEYPAIR="${HOME}/.config/solana/hastra-localnet-id.json"
LEDGER_DIR="/workspace/.anchor/local-validator-ledger"
LOG_FILE="/tmp/solana-validator.log"
TMUX_CONF="/exec-daemon/tmux.portal.conf"
SESSION_NAME="solana_validator"

mkdir -p "${HOME}/.config/solana" "${LEDGER_DIR}"

if [[ ! -f "${KEYPAIR}" ]]; then
  solana-keygen new --no-passphrase --force --outfile "${KEYPAIR}"
fi

solana config set --url http://127.0.0.1:8899
solana config set --keypair "${KEYPAIR}"

if solana cluster-version >/dev/null 2>&1; then
  echo "solana-test-validator already responding"
else
  tmux -f "${TMUX_CONF}" has-session -t "=${SESSION_NAME}" 2>/dev/null &&
    tmux -f "${TMUX_CONF}" kill-session -t "${SESSION_NAME}" || true

  tmux -f "${TMUX_CONF}" new-session -d -s "${SESSION_NAME}" -c /workspace -- \
    "solana-test-validator --reset --ledger ${LEDGER_DIR} 2>&1 | tee ${LOG_FILE}"

  for _ in $(seq 1 90); do
    if solana cluster-version >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done

  if ! solana cluster-version >/dev/null 2>&1; then
    echo "solana-test-validator failed to start; see ${LOG_FILE}" >&2
    exit 1
  fi
fi

LAMPORTS=$(solana balance --lamports 2>/dev/null | awk '{print $1}' || echo 0)
if [[ "${LAMPORTS}" -lt 1000000000 ]]; then
  solana airdrop 1000 || true
fi

echo "cloud-agent-start: validator ready ($(solana cluster-version))"
