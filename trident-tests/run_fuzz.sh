#!/usr/bin/env bash
# Builds and runs fuzz_vault against ../target/deploy (build it with `anchor build -- --features testing`).
# Writes into <out-dir>: fuzz.log (full output), metrics.json (per-instruction counts and the
# master seed) and failures.txt (one line per failing iteration, ending in "(seed: <hex>)").
# Replay one failing iteration with: FUZZ_FLOWS=<flows> TRIDENT_FUZZ_DEBUG=<hex> ./target/release/fuzz_vault
# A master seed reproduces a whole run only with the same thread count (Trident splits the
# iterations per available core and derives each thread's seed from it), which is logged.
# Exit status: 0 clean, 99 an invariant failed or a program panicked, 2 bad usage.
set -euo pipefail

usage() {
  echo "usage: $0 <iterations> <flows-per-iteration> <out-dir> [master-seed: 64 hex chars]" >&2
  exit 2
}

if [ $# -lt 3 ] || [ $# -gt 4 ]; then usage; fi
iterations=$1
flows=$2
out=$(realpath -m "$3")
seed=${4:-$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')}
[[ $iterations =~ ^[0-9]+$ && $flows =~ ^[0-9]+$ && $seed =~ ^[0-9a-f]{64}$ ]] || usage

cd "$(dirname "$0")"
cargo build --release --bin fuzz_vault
mkdir -p "$out"
echo "fuzz_vault: ${iterations} iterations x ${flows} flows, $(nproc) threads, master seed ${seed}"

# Trident reports failing iterations through its progress bar, which prints nothing without a
# terminal, so run under a pseudo-terminal.
status=0
FUZZ_ITERATIONS=$iterations FUZZ_FLOWS=$flows TRIDENT_FUZZ_SEED=$seed TRIDENT_WITH_EXIT_CODE=1 \
  FUZZING_METRICS=1 FUZZING_JSON="$out/metrics.json" \
  script -qefc ./target/release/fuzz_vault "$out/fuzz.tty" > /dev/null || status=$?
sed -E 's/\x1b\[[0-9;?]*[A-Za-z]//g' "$out/fuzz.tty" | tr '\r' '\n' | grep -av '^Overall: ' > "$out/fuzz.log"
rm "$out/fuzz.tty"
grep -ao 'Assertion failed at .*' "$out/fuzz.log" > "$out/failures.txt" || true

grep -a '^[|+]' "$out/fuzz.log" || true
if [ -s "$out/failures.txt" ]; then
  echo "$(wc -l < "$out/failures.txt") failing iteration(s):"
  cut -c1-400 "$out/failures.txt"
  echo "replay one with: FUZZ_FLOWS=${flows} TRIDENT_FUZZ_DEBUG=<seed> $PWD/target/release/fuzz_vault"
fi
echo "fuzz_vault exit status ${status}"
exit "$status"
