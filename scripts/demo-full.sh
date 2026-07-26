#!/usr/bin/env bash
#
# The complete FlightRules demo, end to end, in one command.
#
# Emits real telemetry, mines a real baseline from it, proposes and activates a real contract,
# compiles real SigNoz artefacts, evaluates both releases, and shows the release gate passing on the
# approved release and failing on the unsafe canary.
#
# Nothing here fabricates state. Every step is an API call answered by a real worker, and the two
# gate results at the end are read from the persisted evidence the steps before them produced.
#
# Prerequisites: `make signoz-up && make signoz-bootstrap`, `make up && make db-migrate`,
# `make demo-up`, and the API and worker running (`make api`, `make worker`).
#
#   make demo-full
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
set -a
[ -f .env ] && . ./.env
set +a

PROJECT="${PROJECT:-demo-commerce}"
AGENT="${AGENT:-refund-agent}"
BASELINE_RELEASE="${BASELINE_RELEASE:-refund-agent-v1}"
CANARY_RELEASE="${CANARY_RELEASE:-refund-agent-v2}"
CLI="node apps/cli/dist/index.js"
EVIDENCE_DIR="${EVIDENCE_DIR:-docs/evidence/phase-11}"

banner() { printf '\n\033[1m== %s\033[0m\n' "$1"; }

# Evaluation, retried while SigNoz has not yet made the run queryable.
#
# The demo emits telemetry seconds before it evaluates it, and SigNoz does not make a span queryable
# the instant it is accepted: the collector batches and ClickHouse commits its parts asynchronously.
# On a freshly cast deployment the gap is seconds to a minute, and an evaluation that lands inside it
# reports `insufficient_data` with zero runs — exit 3 — which a fresh-machine reproduction hit on the
# canary. Retrying is honest here: the same real evaluation runs again over the same real window and
# still has to find real runs. It is not a retry on *failure* generally — a violated contract exits 2
# and is returned immediately.
EVAL_ATTEMPTS="${EVAL_ATTEMPTS:-8}"
EVAL_RETRY_SECONDS="${EVAL_RETRY_SECONDS:-15}"

evaluate_release() {
  local release="$1" lookback="$2" attempt code
  for attempt in $(seq 1 "${EVAL_ATTEMPTS}"); do
    set +e
    ${CLI} release evaluate \
      --project "${PROJECT}" --agent "${AGENT}" --release "${release}" \
      --lookback "${lookback}" --timeout 300
    code=$?
    set -e
    # 3 is insufficient data, which at this point in the demo means "not queryable yet".
    if [ "${code}" -ne 3 ]; then return "${code}"; fi
    if [ "${attempt}" -eq "${EVAL_ATTEMPTS}" ]; then
      printf '\n%s still has no completed runs after %s attempts.\n' \
        "${release}" "${EVAL_ATTEMPTS}" >&2
      return 3
    fi
    printf '   no completed run yet; waiting %ss for SigNoz to catch up\n' "${EVAL_RETRY_SECONDS}"
    sleep "${EVAL_RETRY_SECONDS}"
  done
}

banner "1/8  known-good telemetry: ${DEMO_RUNS_V1:-25} runs of ${BASELINE_RELEASE}"
DEMO_RUNS="${DEMO_RUNS_V1:-25}" bash scripts/run-demo-v1.sh

banner "2/8  seed the project, mine the baseline, activate the contract, sync SigNoz"
bash scripts/seed-demo.sh

banner "3/8  evaluate the approved release"
evaluate_release "${BASELINE_RELEASE}" 360

banner "4/8  release gate on the approved release — expecting exit 0"
set +e
${CLI} gate check --project "${PROJECT}" --agent "${AGENT}" --release "${BASELINE_RELEASE}"
PASS_CODE=$?
set -e
printf '\nexit code: %s\n' "${PASS_CODE}"

banner "5/8  unsafe canary telemetry: ${DEMO_RUNS_V2:-8} runs of ${CANARY_RELEASE}"
DEMO_RUNS="${DEMO_RUNS_V2:-8}" bash scripts/run-demo-v2.sh

banner "6/8  evaluate the canary"
evaluate_release "${CANARY_RELEASE}" 60

banner "7/8  release gate on the canary — expecting exit 2"
set +e
${CLI} gate check --project "${PROJECT}" --agent "${AGENT}" --release "${CANARY_RELEASE}"
FAIL_CODE=$?
set -e
printf '\nexit code: %s\n' "${FAIL_CODE}"

banner "8/8  export the evidence"
mkdir -p "${EVIDENCE_DIR}"
${CLI} evidence export --include-violations \
  --project "${PROJECT}" --agent "${AGENT}" --release "${CANARY_RELEASE}" \
  --out "${EVIDENCE_DIR}/canary-gate.json"
${CLI} evidence export \
  --project "${PROJECT}" --agent "${AGENT}" --release "${BASELINE_RELEASE}" \
  --out "${EVIDENCE_DIR}/baseline-gate.json"

banner "result"
printf '  approved release %-20s exit %s\n' "${BASELINE_RELEASE}" "${PASS_CODE}"
printf '  unsafe canary    %-20s exit %s\n' "${CANARY_RELEASE}" "${FAIL_CODE}"
printf '  evidence         %s\n' "${EVIDENCE_DIR}/"

if [ "${PASS_CODE}" -ne 0 ] || [ "${FAIL_CODE}" -ne 2 ]; then
  printf '\nThe demo did not reproduce the expected outcome (0 then 2).\n' >&2
  exit 1
fi

printf '\nA release pipeline failed because of trajectory evidence from SigNoz.\n'
