#!/usr/bin/env bash
#
# Seeds the FlightRules application from an empty database to an active contract, through the
# product's own API. PRD section 13 names this file; the implementation is seed-demo.mjs.
#
# Requires a running API (`make api`), a running worker (`make worker`) and live `refund-agent-v1`
# telemetry in SigNoz (`make demo-v1`).
#
#   make demo-seed
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
set -a
[ -f .env ] && . ./.env
set +a

exec node scripts/seed-demo.mjs "$@"
