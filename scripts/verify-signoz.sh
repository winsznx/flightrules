#!/usr/bin/env bash
# Verifies every SigNoz surface FlightRules depends on, against the running deployment.
#
# Deliberately does not use a bare TCP port check anywhere. Ports 4317 and 4318 accept a TCP
# connection through the Docker userland proxy even when the collector is not listening on them,
# so a port check reports success in exactly the state that breaks ingestion (SL-010).
#
# Direct SigNoz HTTP responses are asserted on their body, never on the status code: unmatched
# API paths return the single-page-application shell with HTTP 200 (SL-012).
set -euo pipefail

SIGNOZ_URL="${SIGNOZ_URL:-http://localhost:8080}"
SIGNOZ_MCP_URL="${SIGNOZ_MCP_URL:-http://localhost:8000/mcp}"
MCP_BASE="${SIGNOZ_MCP_URL%/mcp}"
OTLP_ENDPOINT="${OTEL_EXPORTER_OTLP_ENDPOINT:-http://localhost:4318}"

EXPECTED_SIGNOZ_VERSION="${EXPECTED_SIGNOZ_VERSION:-v0.134.0}"
EXPECTED_MCP_VERSION="${EXPECTED_MCP_VERSION:-v0.9.0}"
EXPECTED_COLLECTOR_IMAGE="${EXPECTED_COLLECTOR_IMAGE:-signoz/signoz-otel-collector:v0.144.6}"

if [ -f .env ]; then
  # shellcheck disable=SC1091
  set -a; . ./.env; set +a
fi

failures=0
pass() { printf '  ok    %s\n' "$1"; }
fail() { printf '  FAIL  %s\n' "$1" >&2; failures=$((failures + 1)); }

printf 'SigNoz verification\n\n'

# ---------------------------------------------------------------------------
printf 'Deployment\n'
# ---------------------------------------------------------------------------
for entry in \
  "signoz-signoz-0:signoz/signoz:${EXPECTED_SIGNOZ_VERSION}" \
  "signoz-mcp:signoz/signoz-mcp-server:${EXPECTED_MCP_VERSION}"
do
  container="${entry%%:*}"
  expected="${entry#*:}"
  actual="$(docker inspect --format '{{.Config.Image}}' "${container}" 2>/dev/null || echo "")"
  if [ "${actual}" = "${expected}" ]; then
    pass "${container} runs ${expected}"
  else
    fail "${container} runs '${actual}', expected '${expected}'"
  fi
done

collector_image="$(docker ps --filter 'name=signoz-ingester' --format '{{.Image}}' | head -n1)"
if [ "${collector_image}" = "${EXPECTED_COLLECTOR_IMAGE}" ]; then
  pass "collector runs ${EXPECTED_COLLECTOR_IMAGE}"
else
  fail "collector runs '${collector_image}', expected '${EXPECTED_COLLECTOR_IMAGE}'"
fi

if grep -q ':latest' pours/deployment/compose.yaml 2>/dev/null; then
  fail "pours/deployment/compose.yaml still contains a ':latest' image tag"
else
  pass "no floating ':latest' image tag in the generated Compose file"
fi

# ---------------------------------------------------------------------------
printf '\nSigNoz API\n'
# ---------------------------------------------------------------------------
health="$(curl -sf --max-time 10 "${SIGNOZ_URL}/api/v1/health" 2>/dev/null || echo "")"
if printf '%s' "${health}" | grep -q '"status":"ok"'; then
  pass "GET /api/v1/health reports ok"
else
  fail "GET /api/v1/health did not report ok (body: ${health:0:80})"
fi

version_body="$(curl -sf --max-time 10 "${SIGNOZ_URL}/api/v1/version" 2>/dev/null || echo "")"
if printf '%s' "${version_body}" | grep -q "\"version\":\"${EXPECTED_SIGNOZ_VERSION}\""; then
  pass "SigNoz reports ${EXPECTED_SIGNOZ_VERSION}"
else
  fail "SigNoz version mismatch (body: ${version_body:0:120})"
fi

if printf '%s' "${version_body}" | grep -q '"setupCompleted":true'; then
  pass "first-user setup is complete"
else
  fail "setup is not complete; run scripts/bootstrap-signoz.sh (OTLP will not ingest until it is)"
fi

# ---------------------------------------------------------------------------
printf '\nSigNoz MCP Server\n'
# ---------------------------------------------------------------------------
livez="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "${MCP_BASE}/livez" || echo "000")"
[ "${livez}" = "200" ] && pass "GET /livez returns 200" || fail "GET /livez returned ${livez}"

readyz="$(curl -s -w '\n%{http_code}' --max-time 15 "${MCP_BASE}/readyz" || echo "000")"
if [ "$(printf '%s' "${readyz}" | tail -n1)" = "200" ]; then
  pass "GET /readyz returns 200"
else
  fail "GET /readyz returned $(printf '%s' "${readyz}" | tail -n1)"
fi

if [ -z "${SIGNOZ_API_KEY:-}" ] || [ "${SIGNOZ_API_KEY}" = "replace-me" ]; then
  fail "SIGNOZ_API_KEY is not set; run scripts/bootstrap-signoz.sh"
else
  init_payload='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"flightrules-verify","version":"0.1.0"}}}'

  authed="$(curl -s --max-time 20 -X POST "${SIGNOZ_MCP_URL}" \
    -H "SIGNOZ-API-KEY: ${SIGNOZ_API_KEY}" \
    -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' \
    -d "${init_payload}" || echo "")"

  if printf '%s' "${authed}" | grep -q "\"version\":\"${EXPECTED_MCP_VERSION}\""; then
    pass "MCP initialize succeeds and reports ${EXPECTED_MCP_VERSION}"
  else
    fail "MCP initialize did not report ${EXPECTED_MCP_VERSION} (body: ${authed:0:160})"
  fi

  # The minted key must actually *work*, not merely exist and open a session.
  #
  # `initialize` succeeds against the MCP server without the SigNoz credential ever being presented
  # to SigNoz, so it passes with a key SigNoz will reject. A fresh-machine reproduction found
  # exactly that: bootstrap had failed, `.env` still held `replace-me`, this script reported the
  # MCP server healthy, and every tool call afterwards returned
  # `SigNoz API error: unexpected status 401: unauthenticated`. Only a real tool call proves the
  # credential.
  tool_body="$(curl -s --max-time 30 -X POST "${SIGNOZ_MCP_URL}" \
    -H "SIGNOZ-API-KEY: ${SIGNOZ_API_KEY}" \
    -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' \
    -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"signoz_list_services","arguments":{"searchContext":"FlightRules verification: confirm the minted API key is accepted by SigNoz"}}}' \
    || echo "")"

  if printf '%s' "${tool_body}" | grep -qiE '401|unauthenticated|unauthorized|"isError":true'; then
    fail "the minted API key was rejected by SigNoz (body: ${tool_body:0:200})"
  elif printf '%s' "${tool_body}" | grep -q '"result"'; then
    pass "the minted API key is accepted by SigNoz on a real tool call"
  else
    fail "a tool call with the minted key returned no result (body: ${tool_body:0:200})"
  fi

  # A wrong key must be rejected. If it is accepted, authentication is not being enforced.
  unauthed_code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 -X POST "${SIGNOZ_MCP_URL}" \
    -H "SIGNOZ-API-KEY: definitely-not-a-valid-flightrules-key" \
    -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' \
    -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"signoz_list_services","arguments":{"searchContext":"FlightRules verification: confirm an invalid API key is rejected"}}}' \
    || echo "000")"

  unauthed_body="$(curl -s --max-time 20 -X POST "${SIGNOZ_MCP_URL}" \
    -H "SIGNOZ-API-KEY: definitely-not-a-valid-flightrules-key" \
    -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' \
    -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"signoz_list_services","arguments":{"searchContext":"FlightRules verification: confirm an invalid API key is rejected"}}}' \
    || echo "")"

  if [ "${unauthed_code}" != "200" ] || printf '%s' "${unauthed_body}" | grep -qiE 'unauthor|forbidden|invalid|"isError":true'; then
    pass "an invalid API key is rejected"
  else
    fail "an invalid API key was accepted (code ${unauthed_code}, body: ${unauthed_body:0:160})"
  fi
fi

# ---------------------------------------------------------------------------
printf '\nOTLP ingestion\n'
# ---------------------------------------------------------------------------
otlp_code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 \
  -X POST "${OTLP_ENDPOINT}/v1/traces" \
  -H 'Content-Type: application/json' -d '{"resourceSpans":[]}' || echo "000")"
if [ "${otlp_code}" = "200" ]; then
  pass "POST ${OTLP_ENDPOINT}/v1/traces returns 200"
else
  fail "POST ${OTLP_ENDPOINT}/v1/traces returned ${otlp_code} (not a port check: the receiver is not accepting spans)"
fi

grpc_bound="$(docker exec "$(docker ps --filter 'name=signoz-ingester' --format '{{.Names}}' | head -n1)" \
  sh -c 'cat /proc/net/tcp6 2>/dev/null' 2>/dev/null | \
  python3 -c 'import sys
ports=set()
for i,l in enumerate(sys.stdin):
    if i==0: continue
    parts=l.split()
    if len(parts)>1 and ":" in parts[1]:
        ports.add(int(parts[1].split(":")[1],16))
print("yes" if 4317 in ports else "no")' 2>/dev/null || echo "unknown")"
if [ "${grpc_bound}" = "yes" ]; then
  pass "the collector is listening on OTLP gRPC 4317"
else
  fail "the collector is not listening on OTLP gRPC 4317 (state: ${grpc_bound})"
fi

# ---------------------------------------------------------------------------
printf '\nProduction safety\n'
# ---------------------------------------------------------------------------
if grep -qE '^\s+-\s+8000:8000' pours/deployment/compose.yaml 2>/dev/null; then
  printf '  note  the MCP port is published on the host. Correct for local development;\n'
  printf '        it must not be published in a production deployment (PRD section 18.2).\n'
fi

# ---------------------------------------------------------------------------
if [ "${failures}" -ne 0 ]; then
  printf '\n%d SigNoz check(s) failed.\n' "${failures}" >&2
  exit 1
fi
printf '\nAll SigNoz checks passed.\n'
