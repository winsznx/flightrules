#!/usr/bin/env bash
#
# Validates every committed contract document.
#
# A contract that does not validate is invalid configuration, so this exits non-zero and CI stops.
# It runs against the built CLI rather than importing the validator, which means it also proves the
# published `bin` entry point works — the form Phase 11 will wrap as `flightrules contract validate`.
set -euo pipefail

cd "$(dirname "$0")/.."

CLI="packages/contract-schema/dist/cli.js"

if [ ! -f "$CLI" ]; then
  printf 'Building @flightrules/contract-schema first.\n'
  pnpm --filter @flightrules/contract-schema run build >/dev/null
fi

# Production contracts, the per-rule test fixtures, and the contract the baseline miner generated
# from live telemetry. The fixtures are included deliberately: a fixture that stopped validating would
# silently weaken the evaluator's test coverage. The generated contract is included because a document
# the miner emits must keep validating as the DSL changes, and regenerating it is one command
# (`make mine-demo-baseline`).
mapfile -t documents < <(
  find contracts packages/contract-engine/fixtures/contracts docs/evidence/phase-08 \
    -type f -name '*.yaml' 2>/dev/null | sort
)

if [ "${#documents[@]}" -eq 0 ]; then
  printf 'No contract documents found.\n' >&2
  exit 5
fi

failed=0
for document in "${documents[@]}"; do
  if node "$CLI" validate "$document"; then
    :
  else
    failed=1
  fi
done

if [ "$failed" -ne 0 ]; then
  printf '\nOne or more contracts failed validation.\n' >&2
  exit 5
fi

printf '\nAll %d contract document(s) are valid.\n' "${#documents[@]}"
