#!/usr/bin/env bash
# run-tests.sh — copy project to /tmp and run full test suite
# Usage: ./scripts/run-tests.sh
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP_DIR="/tmp/hastra-sol-vault"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  hastra-sol-vault test runner"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# ── Step 1: Copy project ──────────────────────────────────────────────────────
echo ""
echo "▶ Step 1/4  Copying project to $TMP_DIR ..."
rsync -a --checksum \
  --exclude=node_modules \
  --exclude=target \
  --exclude=test-ledger \
  --exclude=.git \
  "$PROJECT_ROOT/" "$TMP_DIR/"
echo "  ✅ Copy done"

# ── Step 2: Install dependencies ─────────────────────────────────────────────
echo ""
echo "▶ Step 2/4  Installing node dependencies ..."
cd "$TMP_DIR"
yarn install --frozen-lockfile --silent
echo "  ✅ Dependencies ready"

# ── Step 3: Build ────────────────────────────────────────────────────────────
echo ""
echo "▶ Step 3/4  Building ..."
# IDL and program binaries include testing-only instructions used by the suite
# (set_price_for_testing, cpi_invoke_for_testing).
anchor build -- --features testing
# Rebuild BPF binaries with the testing feature so those instructions are in the
# on-chain binaries. cd into each crate to avoid manifest-path issues.
(cd programs/vault-stake && cargo build-sbf --features testing 2>&1)
(cd programs/vault-mint && cargo build-sbf --features testing 2>&1)
echo "  ✅ Build complete"

# ── Step 4: Run tests ─────────────────────────────────────────────────────────
echo ""
echo "▶ Step 4/4  Running tests ..."

# anchor test starts its own validator on the configured RPC port.
EXISTING=$(ps aux | grep solana-test-validator | grep -v grep | awk '{print $2}' || true)
if [ -n "$EXISTING" ]; then
  echo "  Killing existing validator (PID $EXISTING) ..."
  kill $EXISTING 2>/dev/null || true
  sleep 2
fi

# Anchor loads the programs at genesis at their [programs.localnet] (production) IDs.
anchor test --skip-build

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Done."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
