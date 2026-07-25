#!/usr/bin/env bash
# Verifies the local toolchain matches what Phase 00 pinned. Fails loudly rather than letting a
# mismatched runtime produce results that cannot be reproduced.
set -euo pipefail

REQUIRED_NODE_MAJOR=24
REQUIRED_NODE_MINIMUM="24.14.1"
REQUIRED_PNPM="10.33.0"

failures=0

fail() {
  printf '  FAIL  %s\n' "$1" >&2
  failures=$((failures + 1))
}

ok() {
  printf '  ok    %s\n' "$1"
}

version_ge() {
  [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -n1)" = "$2" ]
}

printf 'FlightRules environment check\n'

if ! command -v node >/dev/null 2>&1; then
  fail "node is not installed (need >= ${REQUIRED_NODE_MINIMUM} < 25)"
else
  node_version="$(node --version | sed 's/^v//')"
  node_major="${node_version%%.*}"
  if [ "${node_major}" != "${REQUIRED_NODE_MAJOR}" ]; then
    fail "node ${node_version} (need major ${REQUIRED_NODE_MAJOR}; see .nvmrc)"
  elif ! version_ge "${node_version}" "${REQUIRED_NODE_MINIMUM}"; then
    fail "node ${node_version} (need >= ${REQUIRED_NODE_MINIMUM})"
  else
    ok "node ${node_version}"
  fi
fi

if ! command -v pnpm >/dev/null 2>&1; then
  fail "pnpm is not installed (need ${REQUIRED_PNPM})"
else
  pnpm_version="$(pnpm --version)"
  if [ "${pnpm_version}" != "${REQUIRED_PNPM}" ]; then
    fail "pnpm ${pnpm_version} (need ${REQUIRED_PNPM}; run: corepack use pnpm@${REQUIRED_PNPM})"
  else
    ok "pnpm ${pnpm_version}"
  fi
fi

if ! command -v docker >/dev/null 2>&1; then
  fail "docker is not installed"
elif ! docker info >/dev/null 2>&1; then
  fail "docker is installed but the daemon is not reachable"
else
  ok "docker $(docker --version | awk '{print $3}' | tr -d ',')"
fi

if ! docker compose version >/dev/null 2>&1; then
  fail "docker compose plugin is not available"
else
  ok "docker compose $(docker compose version --short)"
fi

if ! command -v git >/dev/null 2>&1; then
  fail "git is not installed"
else
  ok "git $(git --version | awk '{print $3}')"
fi

if command -v foundryctl >/dev/null 2>&1; then
  ok "foundryctl $(foundryctl version 2>/dev/null | awk '/Version:/{print $2}')"
else
  printf '  note  foundryctl is not installed; required from Phase 02 onward.\n'
  printf '        install: curl -fsSL https://signoz.io/foundry.sh | FOUNDRY_VERSION=v0.2.16 bash\n'
fi

if [ -f .env ]; then
  ok ".env present"
else
  printf '  note  .env is missing; copy .env.example to .env before running the stack.\n'
fi

if [ "${failures}" -ne 0 ]; then
  printf '\n%d environment check(s) failed.\n' "${failures}" >&2
  exit 1
fi

printf '\nEnvironment OK.\n'
