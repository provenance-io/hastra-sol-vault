#!/bin/bash
# Fail if a program IDL or binary exposes a `testing`-feature instruction.
# Usage: check_release_artifacts.sh <artifact>...   (IDL JSON and/or program .so)
# Exit 0 = all clean; exit 1 = a testing instruction was found (matches are printed); 2 = bad usage.

set -euo pipefail

if [ "$#" -eq 0 ]; then
  echo "usage: $0 <artifact>..." >&2
  exit 2
fi

# Matches the IDL name (set_price_for_testing), the instruction log string Anchor embeds in the
# binary (SetPriceForTesting), and handler msg! text.
PATTERN='set_?price_?for_?testing|apply_?verified_?report_?for_?testing'

found=0
for artifact in "$@"; do
  if [ ! -s "${artifact}" ]; then
    echo "missing or empty artifact: ${artifact}" >&2
    exit 2
  fi
  matches="$(grep -aoiE "${PATTERN}" "${artifact}" | sort -u || true)"
  if [ -n "${matches}" ]; then
    echo "${artifact}: testing instruction present:"
    echo "${matches}" | sed 's/^/  /'
    found=1
  else
    echo "${artifact}: clean"
  fi
done

exit "${found}"
