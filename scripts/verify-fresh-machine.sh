#!/usr/bin/env bash
#
# The fresh-machine reproducibility test (PRD Phase 16 task 16, PRD section 22.5).
#
# Clones this repository into a directory outside the working tree and brings the whole product up
# there from **committed files and documented prerequisites only** — no `.env`, no database, no
# Docker volume, no generated artefact and no credential is carried across. It then runs the demo
# and asserts the two exit codes the product claim rests on.
#
# It is destructive by necessity. The SigNoz deployment, the FlightRules database and their volumes
# are shared by every clone on this host — Foundry's Compose project is `signoz` and the
# application's is `flightrules` — so a clone that reused them would be testing this machine's
# accumulated state rather than a fresh one. The script therefore destroys both before it begins,
# and says so.
#
#   bash scripts/verify-fresh-machine.sh                    # full run, from a clean clone
#   CLONE_DIR=/tmp/fr bash scripts/verify-fresh-machine.sh  # a chosen location
#   SKIP_DESTROY=1 bash scripts/verify-fresh-machine.sh     # re-run against what is already up
#
# Every step prints the command it ran. A step that needs a human decision fails rather than
# guessing, because a manual correction that the script hid would be exactly the undocumented
# installation step this test exists to find.
set -uo pipefail

SOURCE_REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLONE_DIR="${CLONE_DIR:-${TMPDIR:-/tmp/}flightrules-fresh-$(date +%s)}"
LOG_DIR="${LOG_DIR:-${SOURCE_REPO}/docs/evidence/phase-16}"
REPORT="${LOG_DIR}/fresh-machine.txt"

failures=0
step() { printf '\n\033[1m== %s\033[0m\n' "$1" | tee -a "${REPORT}"; }
pass() { printf '  ok    %s\n' "$1" | tee -a "${REPORT}"; }
fail() { printf '  FAIL  %s\n' "$1" | tee -a "${REPORT}" >&2; failures=$((failures + 1)); }
info() { printf '        %s\n' "$1" | tee -a "${REPORT}"; }

run() {
  local label="$1"; shift
  printf '  run   %s\n' "$*" | tee -a "${REPORT}"
  local status=0
  "$@" >>"${REPORT}" 2>&1 || status=$?
  if [ "${status}" -eq 0 ]; then pass "${label}"; return 0; fi
  fail "${label} (exit ${status})"
  return 1
}

mkdir -p "${LOG_DIR}"
: >"${REPORT}"
printf 'FlightRules fresh-machine reproduction\nsource %s\nclone  %s\nstarted %s\n' \
  "${SOURCE_REPO}" "${CLONE_DIR}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" | tee -a "${REPORT}"

# ---------------------------------------------------------------------------
step "0  destroy the shared state a fresh machine would not have"
# ---------------------------------------------------------------------------
if [ "${SKIP_DESTROY:-0}" = "1" ]; then
  info "SKIP_DESTROY=1, leaving the deployment in place"
else
  pkill -f 'apps/api/dist/index.js' 2>/dev/null || true
  pkill -f 'apps/worker/dist/index.js' 2>/dev/null || true
  pkill -f 'next start' 2>/dev/null || true
  (cd "${SOURCE_REPO}" && docker compose -f pours/deployment/compose.yaml -p signoz down -v \
    >>"${REPORT}" 2>&1) || true
  (cd "${SOURCE_REPO}" && docker compose -f compose.app.yaml down -v >>"${REPORT}" 2>&1) || true
  pass "SigNoz and application volumes destroyed"
fi

# ---------------------------------------------------------------------------
step "1  clone, committed files only"
# ---------------------------------------------------------------------------
rm -rf "${CLONE_DIR}"
run "git clone" git clone --quiet "${SOURCE_REPO}" "${CLONE_DIR}" || exit 1
cd "${CLONE_DIR}" || exit 1

for forbidden in .env .demo-state.json node_modules pours/deployment/compose.yaml; do
  case "${forbidden}" in
    pours/*)
      # `pours/` **is** committed, deliberately: a judge must be able to read the pinned image tags
      # before installing Foundry. Its presence is correct; a `.env` beside it would not be.
      [ -e "${forbidden}" ] && pass "committed: ${forbidden}"
      ;;
    *)
      if [ -e "${forbidden}" ]; then
        fail "the clone carries ${forbidden}, which a fresh machine would not have"
      else
        pass "absent, as it must be: ${forbidden}"
      fi
      ;;
  esac
done

# ---------------------------------------------------------------------------
step "2  the documented prerequisites"
# ---------------------------------------------------------------------------
run "make verify-env" make verify-env

# ---------------------------------------------------------------------------
step "3  install from the committed lockfile"
# ---------------------------------------------------------------------------
run "make install" make install || exit 1

# ---------------------------------------------------------------------------
step "4  environment configuration, exactly as the README documents it"
# ---------------------------------------------------------------------------
cp .env.example .env
chmod 600 .env
pass "cp .env.example .env"

# ---------------------------------------------------------------------------
step "5  deploy SigNoz through Foundry"
# ---------------------------------------------------------------------------
run "make signoz-gauge" make signoz-gauge
run "make signoz-forge" make signoz-forge
if [ -n "$(git status --porcelain casting.yaml.lock pours 2>/dev/null)" ]; then
  fail "forge changed casting.yaml.lock or pours/ — the committed lock does not reproduce"
  git --no-pager diff --stat casting.yaml.lock pours >>"${REPORT}" 2>&1 || true
else
  pass "casting.yaml.lock and pours/ reproduce byte-identically"
fi
run "make signoz-up" make signoz-up || exit 1
run "make signoz-reproducibility" make signoz-reproducibility

# ---------------------------------------------------------------------------
step "6  first-user bootstrap and the SigNoz credential"
# ---------------------------------------------------------------------------
# The `Aa1!` suffix is not decoration. SigNoz v0.134.0 requires at least 12 characters with an
# uppercase letter, a lowercase letter, a digit and a symbol, and `openssl rand -base64 18` draws
# from an alphabet that supplies the last two only by luck. This is the same command the runbook,
# the README and the demo script document.
SIGNOZ_ADMIN_PASSWORD="${SIGNOZ_ADMIN_PASSWORD:-$(openssl rand -base64 18)Aa1!}"
export SIGNOZ_ADMIN_PASSWORD
if make signoz-bootstrap >>"${REPORT}" 2>&1; then
  pass "make signoz-bootstrap"
else
  fail "make signoz-bootstrap"
fi

if grep -qE '^SIGNOZ_API_KEY=.+' .env && ! grep -q '^SIGNOZ_API_KEY=replace-me' .env; then
  pass "a SigNoz API key was minted into .env"
else
  fail "no SigNoz API key in .env after bootstrap"
fi

# The credential must never be printed. Assert its shape, never its value.
key_length="$(grep '^SIGNOZ_API_KEY=' .env | cut -d= -f2- | tr -d '\n' | wc -c | tr -d ' ')"
if [ "${key_length}" -ge 16 ]; then pass "credential length ${key_length}"; else fail "credential too short"; fi

run "make signoz-verify" make signoz-verify

# ---------------------------------------------------------------------------
step "7  PostgreSQL and migrations"
# ---------------------------------------------------------------------------
run "make up" make up || exit 1
run "make db-migrate" make db-migrate
run "make db-status" make db-status

# ---------------------------------------------------------------------------
step "8  build, then start the API, the worker and the web application"
# ---------------------------------------------------------------------------
run "make build" make build || exit 1

set -a; . ./.env; set +a
nohup node apps/api/dist/index.js >"${CLONE_DIR}/api.log" 2>&1 &
API_PID=$!
nohup node apps/worker/dist/index.js >"${CLONE_DIR}/worker.log" 2>&1 &
WORKER_PID=$!
trap 'kill ${API_PID} ${WORKER_PID} ${WEB_PID:-} 2>/dev/null || true' EXIT

for _ in $(seq 1 30); do
  if curl -fsS "http://localhost:${API_PORT:-4000}/health/ready" >/dev/null 2>&1; then break; fi
  sleep 2
done
if curl -fsS "http://localhost:${API_PORT:-4000}/health/ready" | grep -q '"status":"ready"'; then
  pass "API ready"
else
  fail "API did not become ready"
fi

WEB_PORT="${WEB_PORT:-3000}" nohup pnpm --filter @flightrules/web run start \
  >"${CLONE_DIR}/web.log" 2>&1 &
WEB_PID=$!
for _ in $(seq 1 30); do
  if curl -fsS "http://localhost:${WEB_PORT:-3000}/" >/dev/null 2>&1; then break; fi
  sleep 2
done
if curl -fsS "http://localhost:${WEB_PORT:-3000}/" >/dev/null 2>&1; then
  pass "web application serving on ${WEB_PORT:-3000}"
else
  fail "web application did not start"
fi

# ---------------------------------------------------------------------------
step "9  the worker survives an idle period"
# ---------------------------------------------------------------------------
# The defect this proves absent: an `unref`ed idle poll timer let the worker exit silently once
# postgres.js closed its idle connections, after logging nothing but successes. Nothing else would
# have shown it — the API stays up and the database stays up.
info "leaving the worker idle for 90 seconds"
sleep 90
if kill -0 "${WORKER_PID}" 2>/dev/null; then
  pass "worker still alive after 90 idle seconds"
else
  fail "the worker exited while idle"
fi

queue="$(curl -fsS "http://localhost:${API_PORT:-4000}/health/dependencies" 2>/dev/null || echo '')"
if printf '%s' "${queue}" | grep -q '"status":"ok"'; then
  pass "queue depth reports ok"
else
  fail "queue depth did not report ok: ${queue}"
fi

# ---------------------------------------------------------------------------
step "10  the demo, end to end"
# ---------------------------------------------------------------------------
run "make demo-up" make demo-up || exit 1
if make demo-full >>"${REPORT}" 2>&1; then
  pass "make demo-full — approved exit 0, unsafe canary exit 2"
else
  fail "make demo-full"
fi

# ---------------------------------------------------------------------------
step "11  the release gate, read back independently"
# ---------------------------------------------------------------------------
set +e
RELEASE=refund-agent-v1 make gate >>"${REPORT}" 2>&1
approved=$?
RELEASE=refund-agent-v2 make gate >>"${REPORT}" 2>&1
canary=$?
set -e
[ "${approved}" -eq 0 ] && pass "approved release exit 0" || fail "approved release exit ${approved}"
[ "${canary}" -eq 2 ] && pass "unsafe canary exit 2" || fail "unsafe canary exit ${canary}"

# ---------------------------------------------------------------------------
step "12  ten managed SigNoz artefacts, verified by read-back"
# ---------------------------------------------------------------------------
project_id="$(curl -fsS "http://localhost:${API_PORT:-4000}/api/projects?limit=10" 2>/dev/null | \
  python3 -c 'import json,sys;d=json.load(sys.stdin);print(d["items"][0]["id"])' 2>/dev/null || echo '')"
if [ -n "${project_id}" ]; then
  summary="$(curl -fsS \
    "http://localhost:${API_PORT:-4000}/api/setup/signoz/artifacts?projectId=${project_id}" \
    2>/dev/null | python3 -c 'import json,sys;print(json.dumps(json.load(sys.stdin)["summary"]))' \
    2>/dev/null || echo '')"
  info "artefact register: ${summary}"
  if printf '%s' "${summary}" | python3 -c 'import json,sys
s=json.load(sys.stdin)
sys.exit(0 if s.get("total")==10 and s.get("synced")==10 and s.get("failed")==0
         and s.get("conflict")==0 else 1)' 2>/dev/null; then
    pass "ten artefacts synced, none failed, none in conflict"
  else
    fail "the artefact register does not report ten synced artefacts"
  fi
else
  fail "no project found through the API"
fi

# ---------------------------------------------------------------------------
step "13  exported metrics and logs reach SigNoz"
# ---------------------------------------------------------------------------
# `make demo-urls` first: `verify-telemetry` correlates against the trace of a real violation, which
# it reads from `.demo-state.json`. Without it the log check fails with "no trace to correlate
# against" — which is what a fresh reproduction found, and is a missing step in the sequence rather
# than a missing capability.
run "make demo-urls" make demo-urls

# On a brand-new deployment SigNoz's metric catalogue lags its first data points, so
# `signoz_list_metrics` can report a metric as absent for a minute or two after it was first
# written. Retried rather than waited on blindly, and the failure is still a failure if it persists.
telemetry_ok=0
for attempt in 1 2 3 4 5 6; do
  if make verify-telemetry >>"${REPORT}" 2>&1; then telemetry_ok=1; break; fi
  info "verify-telemetry attempt ${attempt} failed; the metric catalogue may still be warming"
  sleep 30
done
if [ "${telemetry_ok}" -eq 1 ]; then
  pass "make verify-telemetry"
else
  fail "make verify-telemetry after six attempts"
fi

# ---------------------------------------------------------------------------
step "14  the web routes a judge opens"
# ---------------------------------------------------------------------------
for route in / /setup /projects /demo; do
  code="$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:${WEB_PORT:-3000}${route}")"
  if [ "${code}" = "200" ]; then pass "GET ${route} 200"; else fail "GET ${route} ${code}"; fi
done

# ---------------------------------------------------------------------------
step "15  the documented test commands"
# ---------------------------------------------------------------------------
# The web server is stopped first, and that ordering is load-bearing: `make verify` builds, and
# `next build` and a running `next start` share `.next`. Building underneath a live server fails
# with `Cannot read properties of null (reading 'useContext')` while prerendering `/_global-error` —
# a message that says nothing about the real cause. `docs/RUNBOOK.md` records the same trap.
kill "${WEB_PID}" 2>/dev/null || true
pkill -f 'next start' 2>/dev/null || true
sleep 2
run "make verify" make verify

# ---------------------------------------------------------------------------
printf '\n' | tee -a "${REPORT}"
if [ "${failures}" -eq 0 ]; then
  printf 'Fresh-machine reproduction PASSED. Clone: %s\n' "${CLONE_DIR}" | tee -a "${REPORT}"
  exit 0
fi
printf 'Fresh-machine reproduction FAILED with %d problem(s). Clone: %s\n' \
  "${failures}" "${CLONE_DIR}" | tee -a "${REPORT}"
exit 1
