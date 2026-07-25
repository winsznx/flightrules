#!/usr/bin/env bash
# Resets the demo to a known state without touching the SigNoz installation.
#
# Clears the payment ledger and sent notifications. SigNoz telemetry from prior runs is left in
# place; it is time-bounded evidence, and destroying it would also destroy the baseline a judge
# may already have captured. Use `make signoz-destroy` for a full telemetry wipe.
set -euo pipefail
PAYMENT_URL="${PAYMENT_SERVICE_URL:-http://localhost:4104}"
NOTIFICATION_URL="${NOTIFICATION_SERVICE_URL:-http://localhost:4105}"

fail=0
for entry in "payment-service ${PAYMENT_URL}/payments/reset" "notification-service ${NOTIFICATION_URL}/notifications/reset"; do
  name="${entry%% *}"
  url="${entry#* }"
  body="$(curl -s --max-time 15 -X POST "${url}" || echo "")"
  if printf '%s' "${body}" | grep -q '"status":"reset"'; then
    printf '  ok    %s reset\n' "${name}"
  else
    printf '  FAIL  %s did not reset: %s\n' "${name}" "${body:0:160}" >&2
    fail=1
  fi
done

[ "${fail}" -eq 0 ] || { printf '\nDemo reset incomplete.\n' >&2; exit 1; }
printf '\nDemo reset. The SigNoz installation and its telemetry are untouched.\n'
