#!/usr/bin/env bash
set -euo pipefail

export PATH="/home/ubuntu/.local/share/solana/install/active_release/bin:/usr/local/cargo/bin:/usr/local/bin:${PATH}"

KEYPAIR="${HOME}/.config/solana/hastra-localnet-id.json"
LOG_FILE="/tmp/solana-validator.log"
TMUX_CONF="/exec-daemon/tmux.portal.conf"
SESSION_NAME="solana_validator"

mkdir -p "${HOME}/.config/solana"

if [[ ! -f "${KEYPAIR}" ]]; then
  solana-keygen new --no-passphrase --force --outfile "${KEYPAIR}"
fi

solana config set --url http://127.0.0.1:8899
solana config set --keypair "${KEYPAIR}"

cli_version="$(solana --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true)"
cluster_version=""
if solana cluster-version >/dev/null 2>&1; then
  cluster_version="$(solana cluster-version 2>/dev/null | grep -oE '^[0-9]+\.[0-9]+\.[0-9]+' || true)"
fi

stop_validator() {
  tmux -f "${TMUX_CONF}" has-session -t "=${SESSION_NAME}" 2>/dev/null &&
    tmux -f "${TMUX_CONF}" kill-session -t "${SESSION_NAME}" || true
  pkill -f solana-test-validator 2>/dev/null || true
  sleep 2
}

start_validator() {
  stop_validator
  # anchor localnet loads the built programs at genesis at their [programs.localnet]
  # (production) IDs, upgradeable by the provider wallet.
  tmux -f "${TMUX_CONF}" new-session -d -s "${SESSION_NAME}" -c /workspace -- \
    "anchor localnet --skip-build 2>&1 | tee ${LOG_FILE}"

  for _ in $(seq 1 90); do
    if solana cluster-version >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

if [[ -n "${cluster_version}" && -n "${cli_version}" && "${cluster_version}" == "${cli_version}" ]]; then
  echo "solana-test-validator already responding (v${cluster_version})"
elif [[ -n "${cluster_version}" && -n "${cli_version}" ]]; then
  echo "restarting validator (cluster v${cluster_version} != CLI v${cli_version})"
  start_validator || {
    echo "solana-test-validator failed to start; see ${LOG_FILE}" >&2
    exit 1
  }
elif solana cluster-version >/dev/null 2>&1; then
  echo "solana-test-validator already responding"
else
  start_validator || {
    echo "solana-test-validator failed to start; see ${LOG_FILE}" >&2
    exit 1
  }
fi

LAMPORTS=$(solana balance --lamports 2>/dev/null | awk '{print $1}' || echo 0)
if [[ "${LAMPORTS}" -lt 1000000000 ]]; then
  solana airdrop 1000 || true
fi

echo "cloud-agent-start: validator ready ($(solana cluster-version))"
