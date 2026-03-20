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
echo "▶ Step 1/5  Copying project to $TMP_DIR ..."
rsync -a \
  --exclude=node_modules \
  --exclude=target \
  --exclude=test-ledger \
  --exclude=.git \
  "$PROJECT_ROOT/" "$TMP_DIR/"
echo "  ✅ Copy done"

# ── Step 2: Install dependencies ─────────────────────────────────────────────
echo ""
echo "▶ Step 2/5  Installing node dependencies ..."
cd "$TMP_DIR"
yarn install --frozen-lockfile --silent
echo "  ✅ Dependencies ready"

# ── Step 3: Sync program IDs and build ───────────────────────────────────────
echo ""
echo "▶ Step 3/5  Syncing program IDs and building ..."
anchor keys sync
anchor build
echo "  ✅ Build complete"

# ── Step 4: Start validator ───────────────────────────────────────────────────
echo ""
echo "▶ Step 4/5  Starting solana-test-validator ..."

# Kill any existing validator
EXISTING=$(ps aux | grep solana-test-validator | grep -v grep | awk '{print $2}' || true)
if [ -n "$EXISTING" ]; then
  echo "  Killing existing validator (PID $EXISTING) ..."
  kill "$EXISTING" 2>/dev/null || true
  sleep 2
fi

solana-test-validator --reset > /tmp/validator-test.log 2>&1 &
VALIDATOR_PID=$!
echo "  Validator started (PID $VALIDATOR_PID), waiting for it to be ready ..."

# Wait up to 30s for RPC to respond
for i in $(seq 1 30); do
  if solana cluster-version > /dev/null 2>&1; then
    echo "  ✅ Validator ready (${i}s)"
    break
  fi
  if [ "$i" -eq 30 ]; then
    echo "  ❌ Validator did not start in 30s. Check /tmp/validator-test.log"
    exit 1
  fi
  sleep 1
done

# ── Step 5: Run tests ─────────────────────────────────────────────────────────
echo ""
echo "▶ Step 5/5  Running tests ..."
anchor test --skip-local-validator

# ── Cleanup ───────────────────────────────────────────────────────────────────
echo ""
echo "  Stopping validator (PID $VALIDATOR_PID) ..."
kill "$VALIDATOR_PID" 2>/dev/null || true
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Done."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
