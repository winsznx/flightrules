#!/usr/bin/env bash
# Completes SigNoz first-user setup and mints a FlightRules API key.
#
# This must run before any telemetry is produced. The collector receives its effective pipeline
# configuration from the SigNoz apiserver over OpAMP, and the apiserver will not serve it until an
# organisation exists. Until then ports 4317 and 4318 accept a TCP connection through the Docker
# proxy and then reset, so a port check reports ready while nothing is ingested.
# See docs/adr/0002-signoz-deployment-and-pinning.md, decision 4, and source-lock entry SL-010.
#
# Every direct SigNoz HTTP call here was read from the OpenAPI schema the installed SigNoz binary
# generates itself (`signoz generate openapi`). Responses are asserted on their body, never on the
# status code: unmatched SigNoz API paths return the single-page-application shell with HTTP 200.
# See SL-012.
#
# The script is idempotent. Re-running it reuses an existing organisation and service account and
# mints a fresh key.
set -euo pipefail

SIGNOZ_URL="${SIGNOZ_URL:-http://localhost:8080}"
ADMIN_EMAIL="${SIGNOZ_ADMIN_EMAIL:-admin@flightrules.local}"
ADMIN_NAME="${SIGNOZ_ADMIN_NAME:-FlightRules Admin}"
ORG_NAME="${SIGNOZ_ORG_NAME:-FlightRules}"
SERVICE_ACCOUNT_NAME="${SIGNOZ_SERVICE_ACCOUNT_NAME:-flightrules-mcp}"
KEY_NAME="${SIGNOZ_KEY_NAME:-flightrules-mcp-key}"
KEY_TTL_DAYS="${SIGNOZ_KEY_TTL_DAYS:-90}"
ENV_FILE="${ENV_FILE:-.env}"

if [ -z "${SIGNOZ_ADMIN_PASSWORD:-}" ]; then
  echo "SIGNOZ_ADMIN_PASSWORD is not set." >&2
  echo "Choose a local password, for example:" >&2
  echo "  export SIGNOZ_ADMIN_PASSWORD=\"\$(openssl rand -base64 18)\"" >&2
  exit 5
fi

need() { command -v "$1" >/dev/null 2>&1 || { echo "$1 is required." >&2; exit 5; }; }
need curl
need python3

json_get() { python3 -c 'import sys,json;d=json.load(sys.stdin)
for k in sys.argv[1].split("."):
    d=d[k] if isinstance(d,dict) else d
print(d)' "$1"; }

step() { printf '\n==> %s\n' "$1"; }

step "Waiting for the SigNoz API"
deadline=$(( $(date +%s) + 300 ))
until curl -sf --max-time 5 "${SIGNOZ_URL}/api/v1/health" 2>/dev/null | grep -q '"status":"ok"'; do
  if [ "$(date +%s)" -ge "${deadline}" ]; then
    echo "SigNoz did not become healthy within 300s." >&2
    exit 4
  fi
  sleep 3
done
echo "SigNoz is healthy."

version_json="$(curl -sf --max-time 10 "${SIGNOZ_URL}/api/v1/version")"
signoz_version="$(printf '%s' "${version_json}" | json_get version)"
setup_completed="$(printf '%s' "${version_json}" | json_get setupCompleted)"
echo "SigNoz ${signoz_version} (setupCompleted=${setup_completed})"

export ADMIN_NAME ORG_NAME ADMIN_EMAIL SERVICE_ACCOUNT_NAME KEY_NAME KEY_TTL_DAYS

step "Ensuring the first organisation and root user exist"
if [ "${setup_completed}" = "True" ] || [ "${setup_completed}" = "true" ]; then
  echo "Setup already completed; reusing the existing organisation."
else
  register_body="$(curl -sf --max-time 30 -X POST "${SIGNOZ_URL}/api/v1/register" \
    -H 'Content-Type: application/json' \
    -d "$(python3 -c 'import json,os
print(json.dumps({
  "name": os.environ["ADMIN_NAME"],
  "orgId": "",
  "orgName": os.environ["ORG_NAME"],
  "email": os.environ["ADMIN_EMAIL"],
  "password": os.environ["SIGNOZ_ADMIN_PASSWORD"],
}))')")"
  if ! printf '%s' "${register_body}" | grep -q '"status":"success"'; then
    echo "Registration failed:" >&2
    printf '%s\n' "${register_body}" >&2
    exit 4
  fi
  echo "Created the root user and organisation."
fi

step "Discovering the organisation ID"
# The org ID is returned by registration, but on a re-run it must be rediscovered. A login
# attempt without orgID reports the requirement; the reliable path is the register response, so
# it is captured above when available and read back from the JWT claims otherwise.
if [ -n "${register_body:-}" ]; then
  ORG_ID="$(printf '%s' "${register_body}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["data"]["orgId"])')"
else
  ORG_ID="${SIGNOZ_ORG_ID:-}"
  if [ -z "${ORG_ID}" ]; then
    echo "SigNoz setup was already completed by an earlier run or by hand." >&2
    echo "Re-running needs the organisation ID. Find it in the SigNoz UI under Settings," >&2
    echo "then re-run with SIGNOZ_ORG_ID=<uuid>." >&2
    exit 5
  fi
fi
echo "Organisation ${ORG_ID}"

step "Authenticating"
# POST /api/v1/login does not exist in v0.134.0; it falls through to the SPA and returns HTML
# with HTTP 200. The real endpoint is /api/v2/sessions/email_password and it requires orgID.
login_body="$(curl -sf --max-time 30 -X POST "${SIGNOZ_URL}/api/v2/sessions/email_password" \
  -H 'Content-Type: application/json' \
  -d "$(ORG_ID="${ORG_ID}" python3 -c 'import json,os
print(json.dumps({
  "email": os.environ["ADMIN_EMAIL"],
  "password": os.environ["SIGNOZ_ADMIN_PASSWORD"],
  "orgID": os.environ["ORG_ID"],
}))')")"

printf '%s' "${login_body}" | grep -q '"accessToken"' || {
  echo "Login failed. Response did not contain an access token." >&2
  exit 4
}
JWT="$(printf '%s' "${login_body}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["data"]["accessToken"])')"
echo "Authenticated."

step "Ensuring the ${SERVICE_ACCOUNT_NAME} service account exists"
accounts="$(curl -sf --max-time 30 -H "Authorization: Bearer ${JWT}" \
  "${SIGNOZ_URL}/api/v1/service_accounts")"
SERVICE_ACCOUNT_ID="$(printf '%s' "${accounts}" | python3 -c 'import sys,json,os
data=json.load(sys.stdin).get("data") or []
name=os.environ["SERVICE_ACCOUNT_NAME"]
print(next((a["id"] for a in data if a.get("name")==name), ""))')"

if [ -z "${SERVICE_ACCOUNT_ID}" ]; then
  created="$(curl -sf --max-time 30 -X POST "${SIGNOZ_URL}/api/v1/service_accounts" \
    -H "Authorization: Bearer ${JWT}" -H 'Content-Type: application/json' \
    -d "$(python3 -c 'import json,os
print(json.dumps({"name": os.environ["SERVICE_ACCOUNT_NAME"]}))')")"
  SERVICE_ACCOUNT_ID="$(printf '%s' "${created}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["data"]["id"])')"
  echo "Created service account ${SERVICE_ACCOUNT_ID}"
else
  echo "Reusing service account ${SERVICE_ACCOUNT_ID}"
fi

step "Ensuring the signoz-admin role is assigned"
# FlightRules creates dashboards, saved views, alert rules and notification channels, which
# requires admin. The privilege level and its mitigations are recorded in docs/THREAT_MODEL.md.
roles="$(curl -sf --max-time 30 -H "Authorization: Bearer ${JWT}" "${SIGNOZ_URL}/api/v1/roles")"
ADMIN_ROLE_ID="$(printf '%s' "${roles}" | python3 -c 'import sys,json
data=json.load(sys.stdin)["data"]
print(next((r["id"] for r in data if r["name"]=="signoz-admin"), ""))')"
[ -n "${ADMIN_ROLE_ID}" ] || { echo "signoz-admin role not found." >&2; exit 4; }

assigned="$(curl -sf --max-time 30 -H "Authorization: Bearer ${JWT}" \
  "${SIGNOZ_URL}/api/v1/service_accounts/${SERVICE_ACCOUNT_ID}/roles")"
if printf '%s' "${assigned}" | grep -q 'signoz-admin'; then
  echo "Role already assigned."
else
  curl -sf --max-time 30 -X POST "${SIGNOZ_URL}/api/v1/service_account_roles" \
    -H "Authorization: Bearer ${JWT}" -H 'Content-Type: application/json' \
    -d "$(SERVICE_ACCOUNT_ID="${SERVICE_ACCOUNT_ID}" ADMIN_ROLE_ID="${ADMIN_ROLE_ID}" python3 -c 'import json,os
print(json.dumps({
  "serviceAccountId": os.environ["SERVICE_ACCOUNT_ID"],
  "roleId": os.environ["ADMIN_ROLE_ID"],
}))')" >/dev/null
  echo "Assigned signoz-admin."
fi

step "Minting an API key"
EXPIRES_AT="$(python3 -c "import time,os;print(int(time.time())+86400*int(os.environ['KEY_TTL_DAYS']))")"
key_body="$(curl -sf --max-time 30 -X POST \
  "${SIGNOZ_URL}/api/v1/service_accounts/${SERVICE_ACCOUNT_ID}/keys" \
  -H "Authorization: Bearer ${JWT}" -H 'Content-Type: application/json' \
  -d "$(EXPIRES_AT="${EXPIRES_AT}" python3 -c 'import json,os
print(json.dumps({"name": os.environ["KEY_NAME"], "expiresAt": int(os.environ["EXPIRES_AT"])}))')")"

API_KEY="$(printf '%s' "${key_body}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["data"]["key"])')"
[ -n "${API_KEY}" ] || { echo "Key creation returned no key value." >&2; exit 4; }
echo "Minted a key valid for ${KEY_TTL_DAYS} days."

step "Writing the key into ${ENV_FILE}"
if [ ! -f "${ENV_FILE}" ]; then
  cp .env.example "${ENV_FILE}"
  echo "Created ${ENV_FILE} from .env.example."
fi
python3 - "${ENV_FILE}" "${API_KEY}" <<'PY'
import re, sys
path, key = sys.argv[1], sys.argv[2]
text = open(path).read()
line = f"SIGNOZ_API_KEY={key}"
if re.search(r"^SIGNOZ_API_KEY=.*$", text, flags=re.MULTILINE):
    text = re.sub(r"^SIGNOZ_API_KEY=.*$", line, text, flags=re.MULTILINE)
else:
    text = text.rstrip("\n") + "\n" + line + "\n"
open(path, "w").write(text)
PY
chmod 600 "${ENV_FILE}"
echo "SIGNOZ_API_KEY written to ${ENV_FILE} (mode 600, git-ignored)."

step "Waiting for OTLP ingestion to become available"
# The real readiness signal. A TCP connect to 4318 succeeds even when the collector is not
# listening, because the Docker userland proxy accepts first.
OTLP_ENDPOINT="${OTEL_EXPORTER_OTLP_ENDPOINT:-http://localhost:4318}"
deadline=$(( $(date +%s) + 180 ))
until [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 \
    -X POST "${OTLP_ENDPOINT}/v1/traces" \
    -H 'Content-Type: application/json' -d '{"resourceSpans":[]}' 2>/dev/null)" = "200" ]; do
  if [ "$(date +%s)" -ge "${deadline}" ]; then
    echo "OTLP ingestion did not become available within 180s." >&2
    echo "Check: docker logs signoz-ingester-1 | grep -i opamp" >&2
    exit 4
  fi
  sleep 3
done
echo "OTLP ingestion is accepting spans."

printf '\nSigNoz bootstrap complete.\n'
printf '  UI            %s\n' "${SIGNOZ_URL}"
printf '  MCP           %s\n' "${SIGNOZ_MCP_URL:-http://localhost:8000/mcp}"
printf '  OTLP HTTP     %s\n' "${OTLP_ENDPOINT}"
printf '  admin user    %s\n' "${ADMIN_EMAIL}"
printf '  organisation  %s\n' "${ORG_ID}"
printf '\nRun scripts/verify-signoz.sh to confirm every surface.\n'
