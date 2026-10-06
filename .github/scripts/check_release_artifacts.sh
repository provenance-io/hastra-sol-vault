#!/bin/bash
# Fail if a program IDL or binary exposes a `testing`-feature instruction.
# Usage: check_release_artifacts.sh <artifact>...   (IDL *.json and/or program .so)
# Exit 0 = all clean; exit 1 = a testing instruction was found (matches are printed); 2 = bad usage.
#
# IDLs are checked by exact instruction name. Binaries are searched for the instruction log string
# Anchor embeds (SetPriceForTesting) and handler msg! text; CI runs this against the testing build
# and requires a match, so a build that stops embedding those strings fails there.

set -euo pipefail

if [ "$#" -eq 0 ]; then
  echo "usage: $0 <artifact>..." >&2
  exit 2
fi

TESTING_INSTRUCTIONS='["set_price_for_testing", "apply_verified_report_for_testing"]'
BINARY_PATTERN='set_?price_?for_?testing|apply_?verified_?report_?for_?testing'

found=0
for artifact in "$@"; do
  if [ ! -s "${artifact}" ]; then
    echo "missing or empty artifact: ${artifact}" >&2
    exit 2
  fi
  if [[ "${artifact}" == *.json ]]; then
    matches="$(jq -r --argjson testing "${TESTING_INSTRUCTIONS}" \
      '.instructions[].name | select(. as $n | $testing | index($n))' "${artifact}")" || {
      echo "unreadable IDL: ${artifact}" >&2
      exit 2
    }
  else
    matches="$(grep -aoiE "${BINARY_PATTERN}" "${artifact}" | sort -u || true)"
  fi
  if [ -n "${matches}" ]; then
    echo "${artifact}: testing instruction present:"
    echo "${matches}" | sed 's/^/  /'
    found=1
  else
    echo "${artifact}: clean"
  fi
done

exit "${found}"
