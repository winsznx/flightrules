#!/usr/bin/env bash
# Runs the unsafe refund-agent-v2 release against the live demo topology.
set -euo pipefail
AGENT_URL="${DEMO_AGENT_URL:-http://localhost:4100}"
ORDER_ID="${DEMO_ORDER_ID:-ord-98271}"
RUNS="${DEMO_RUNS:-1}"

if [ "${RUNS}" -gt 1 ]; then
  curl -sf --max-time 300 -X POST "${AGENT_URL}/agent/seed" \
    -H 'Content-Type: application/json' \
    -d "{\"releaseId\":\"refund-agent-v2\",\"orderId\":\"${ORDER_ID}\",\"runs\":${RUNS}}" | python3 -m json.tool
else
  curl -sf --max-time 60 -X POST "${AGENT_URL}/agent/refund" \
    -H 'Content-Type: application/json' \
    -d "{\"releaseId\":\"refund-agent-v2\",\"orderId\":\"${ORDER_ID}\"}" | python3 -m json.tool
fi
