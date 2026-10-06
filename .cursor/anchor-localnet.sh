#!/usr/bin/env bash
# Run Anchor/Solana build or test with declare_id! matching target/deploy keypairs.
# Usage: .cursor/anchor-localnet.sh anchor build -- --features testing
#        .cursor/anchor-localnet.sh anchor test --skip-local-validator
set -euo pipefail

cd /workspace
export PATH="/home/ubuntu/.local/share/solana/install/active_release/bin:/usr/local/cargo/bin:/usr/local/bin:${PATH}"

# shellcheck source=localnet-program-ids.sh
source "$(dirname "$0")/localnet-program-ids.sh"

if [[ $# -lt 1 ]]; then
  echo "usage: $0 <command...>" >&2
  echo "  example: $0 anchor test --skip-local-validator --skip-build" >&2
  exit 1
fi

localnet_program_ids_no_skip_worktree
localnet_program_ids_sync

set +e
"$@"
status=$?
set -e

localnet_program_ids_skip_worktree
exit "$status"
