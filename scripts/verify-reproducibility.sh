#!/usr/bin/env bash
# Proves the committed casting reproduces the intended deployment.
#
# Re-forges into a temporary directory and compares against what is committed. This catches the
# failure mode that matters: a casting that looks pinned but whose generated Compose file uses
# floating `latest` tags, because `version:` alone does not change the image tag (SL-006).
#
# The assertion is on the image tags in the generated Compose file, not on the lock file's
# `version` field, because the Compose file is what Docker actually runs.
set -euo pipefail

export PATH="${HOME}/.local/bin:${PATH}"

EXPECTED_IMAGES=(
  "signoz/signoz:v0.134.0"
  "signoz/signoz-otel-collector:v0.144.6"
  "signoz/signoz-mcp-server:v0.9.0"
  "postgres:16"
  "clickhouse/clickhouse-server:25.12.5"
  "clickhouse/clickhouse-keeper:25.12.5"
)

failures=0
pass() { printf '  ok    %s\n' "$1"; }
fail() { printf '  FAIL  %s\n' "$1" >&2; failures=$((failures + 1)); }

command -v foundryctl >/dev/null 2>&1 || {
  echo "foundryctl is not installed." >&2
  echo "  curl -fsSL https://signoz.io/foundry.sh | FOUNDRY_VERSION=v0.2.16 bash" >&2
  exit 5
}

printf 'Reproducibility verification\n\n'

printf 'Committed artefacts\n'
for file in casting.yaml casting.yaml.lock pours/deployment/compose.yaml; do
  [ -f "${file}" ] && pass "${file} is present" || fail "${file} is missing"
done
[ "${failures}" -eq 0 ] || { printf '\n%d check(s) failed.\n' "${failures}" >&2; exit 1; }

printf '\nRe-forging into a clean directory\n'
workdir="$(mktemp -d)"
trap 'rm -rf "${workdir}"' EXIT
cp casting.yaml "${workdir}/casting.yaml"

( cd "${workdir}" && foundryctl forge -f casting.yaml --format text --no-ledger --no-updater >/dev/null 2>&1 ) \
  && pass "foundryctl forge succeeds from a clean directory" \
  || { fail "foundryctl forge failed"; exit 1; }

printf '\nComparing regenerated output against what is committed\n'
if diff -q casting.yaml.lock "${workdir}/casting.yaml.lock" >/dev/null 2>&1; then
  pass "casting.yaml.lock reproduces byte for byte"
else
  fail "casting.yaml.lock differs from a fresh forge"
  diff -u casting.yaml.lock "${workdir}/casting.yaml.lock" | head -40 >&2 || true
fi

if diff -rq pours "${workdir}/pours" >/dev/null 2>&1; then
  pass "pours/ reproduces byte for byte"
else
  fail "pours/ differs from a fresh forge"
  diff -rq pours "${workdir}/pours" | head -20 >&2 || true
fi

printf '\nImage pinning in the generated Compose file\n'
compose="pours/deployment/compose.yaml"

if grep -qE 'image:.*:latest' "${compose}"; then
  fail "a floating ':latest' image tag is present"
  grep -nE 'image:.*:latest' "${compose}" >&2
else
  pass "no floating ':latest' image tag"
fi

for image in "${EXPECTED_IMAGES[@]}"; do
  if grep -qF "image: ${image}" "${compose}"; then
    pass "pinned ${image}"
  else
    fail "expected image ${image} is not in ${compose}"
  fi
done

printf '\nDeployment matches the pinned images\n'
if docker ps --format '{{.Names}}' 2>/dev/null | grep -q 'signoz-signoz-0'; then
  while IFS= read -r line; do
    container="${line%% *}"
    image="${line#* }"
    if grep -qF "image: ${image}" "${compose}"; then
      pass "${container} runs ${image}, which the casting pins"
    else
      fail "${container} runs ${image}, which the casting does not pin"
    fi
  done < <(docker ps --filter 'name=signoz' --format '{{.Names}} {{.Image}}')
else
  printf '  note  the SigNoz stack is not running; skipping the live comparison.\n'
  printf '        deploy it with: foundryctl cast -f casting.yaml\n'
fi

if [ "${failures}" -ne 0 ]; then
  printf '\n%d reproducibility check(s) failed.\n' "${failures}" >&2
  exit 1
fi
printf '\nReproducibility verified.\n'
