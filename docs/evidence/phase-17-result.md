# Phase 17 result — release

**Status: PASS.**

Branch `phase/17-release`, cut from `main` at `9f221e6`.

Exit gate: *a judge can clone, follow the README, run the demo, observe SigNoz, trigger v2, and see
the release fail with real evidence.* Both halves are now true — the local one from a clean clone,
and a hosted one that needs no clone at all.

---

## What this phase was actually for

Phase 16 closed with limitation 5: **the GitHub workflow had never run on GitHub.** That was the
whole risk. Running it found three defects, every one of which was invisible on macOS, fatal on a
runner, and would have made the submission's central claim unverifiable by anyone but its author.

| # | Defect | Where it hid | Recorded |
|---|---|---|---|
| 1 | Jobs ran tests without building, so every workspace import failed | `dist/` is always warm locally | `docs/evidence/phase-17/actions.md` |
| 2 | `next build` compiled successfully and exited `1` 47 ms later, silently | `CI` is the discriminator; nothing had ever built with it set | SL-067 |
| 3 | The demo agent could not resolve `host.docker.internal`, so it exported nothing | Docker Desktop injects the name on macOS whether or not you map it | SL-068 |

Defect 2 was found with `NODE_OPTIONS=--trace-exit` on a disposable diagnostic branch; defect 3 by
making the readiness probe report **what SigNoz actually holds** when a release never appears
instead of only that it did not. Both instruments were removed before the tag.

Each fix is pinned by a test that was confirmed to fail without it:

- `apps/web/src/web.test.ts` runs Next.js's own dependency probe with Next.js's own required-package
  list.
- `packages/test-fixtures/src/release-gate-workflow.test.ts` asserts that every service in
  `compose.app.yaml` pointing at `host.docker.internal` maps it.

Nothing was weakened to get green. No `continue-on-error`, no `|| true` around a gate, no deleted
assertion, no skipped test, and the web build step is still there and still runs Next.js's own type
check — which it had not been doing, because the workaround for defect 2's cause had disabled it.

---

## Results

### GitHub Actions

| Workflow | Run | Result |
|---|---|---|
| CI | https://github.com/winsznx/flightrules/actions/runs/30218574060 | **success**, six of six jobs |
| Release gate | https://github.com/winsznx/flightrules/actions/runs/30218574096 | **success** |

The release gate is the product's claim as a workflow: it deploys the pinned SigNoz through Foundry,
emits real telemetry, mines a real baseline, activates a real contract, and then asserts

```text
Release gate — approved release must pass                          exit 0
Release gate — the unsafe canary must be rejected with exit 2      exit 2
```

Both steps passed on `ubuntu-latest`.

### Test totals, measured on the runner

| Suite | Files | Tests |
|---|---|---|
| Unit and property | 62 | **1,419** |
| Database integration | 9 | **171** |
| SigNoz integration | 8 | **115** |
| **Total** | **79** | **1,705** |

Locally, at the same commit: `make test` 1,419 passed in 62 files; format, lint, typecheck, build,
20 contract documents, design tokens, secret scan and licence scan (302 packages) all exit 0.

> `make verify-env` could not be run at the end of this session: the local Docker daemon stopped
> responding and did not recover. Every other step of `make verify` was run and passed, and the
> whole suite ran on a clean runner, which is the stronger evidence.

### The hosted deployment

Sixteen Railway services, publicly reachable, with a publicly reachable SigNoz.
`docs/evidence/phase-17/railway.md` has the full transcript.

| Surface | URL |
|---|---|
| Web application | https://flightrules-web-production.up.railway.app |
| API | https://flightrules-api-production.up.railway.app |
| SigNoz | https://signoz-signoz-production-f19a.up.railway.app |
| SigNoz MCP Server | https://flightrules-signoz-mcp-production.up.railway.app/mcp |
| OTLP ingestion | https://signoz-ingester-production-a417.up.railway.app |
| Demo agent | https://flightrules-demo-agent-production.up.railway.app |

The canonical demo, executed against it:

```text
baseline        1 route family from 26 live runs
contract        validated, approved, active
artefacts       {"total":10,"synced":10,"drifted":0,"failed":0,"conflict":0}
approved gate   exit 0    26 runs, 0 violations
canary gate     exit 2    8 runs, 80 violations, 24 zero-tolerance, 8 duplicate refunds
                          require-policy-retrieve, require-fraud-check, single-payment-refund-write
decisionHash    identical before and after an API restart
telemetry       5 log records correlate to a real violation trace; metric dimensions queryable
worker          19 minutes idle, then claimed and completed a job
```

---

## Two hosted decisions worth stating plainly

**The hosted SigNoz core is not version-pinned by this repository.** Railway has no bind mounts, no
volume shared between services, and no `service_completed_successfully` init container; the Foundry
casting needs all three. Reproducing it would mean publishing three modified images, at which point
it is no longer the committed artefact the thesis rests on. So the hosted core is SigNoz's own
Railway template, the **MCP server is deployed at the pinned `v0.9.0`** because that is what
FlightRules integrates against, and **Foundry remains the reproducible path**: `make signoz-up` from
the committed `casting.yaml`, proven by `make signoz-reproducibility`.

**The hosted SigNoz user interface needs credentials, which are not published,** because no
credential belongs in a public repository. Everything SigNoz-derived that the product itself shows
is visible in the hosted web application without signing in to SigNoz.

Both are in the README's limitations list rather than left for a reviewer to discover.

---

## Mandatory report block

```text
PHASE:            17 — Release
STATUS:           PASS
ENTRY CRITERIA:   met — Phase 16 merged at 9f221e6, make verify exit 0, working tree clean
TESTS:            1,419 unit + 171 database integration + 115 SigNoz integration = 1,705, on a runner
RUNTIME PROOF:    CI run 30218574060 success; Release gate run 30218574096 success with the
                  approved release at exit 0 and the unsafe canary at exit 2; the hosted deployment
                  reproducing the same two results against a publicly reachable SigNoz
DEFECTS FOUND:    3, all CI-only, all fixed and pinned by a test confirmed to fail without the fix
SOURCE LOCK:      SL-067, SL-068 added
BLOCKED:          none
OUTSTANDING:      the video and blog URLs, which are the submitter's to supply
```
