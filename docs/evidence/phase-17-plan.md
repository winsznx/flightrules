# Phase 17 plan — release, documentation, and submission

Branch `phase/17-release`, cut from `main` at `9f221e6` (the Phase 16 merge).

PRD line 3460. Objective: *prepare a judge-reproducible repository and a precise presentation.*

Exit gate: **a judge can clone, follow the README, run the demo, observe SigNoz, trigger v2, and see
the release fail with real evidence.**

---

## Entry verification

| Check | Result |
|---|---|
| Phase 16 merged | `9f221e6`, `merge(phase-16)` |
| `make verify` on `main` | exit 0, 1,416 tests, 62 files |
| `make test-integration` | 286 passed, 0 failed, 17 files |
| `make test-e2e` | 89 passed, 4 skipped, 4 projects |
| `make demo-full` | exit 0 — approved exit 0, canary exit 2 |
| `make verify-telemetry` | exit 0 |
| `make verify-alerts` | firing and recovery observed |
| `make verify-fresh-machine` | every stage passes on a clean clone |
| five security scans | exit 0 |
| working tree | clean |

## The blocker to state before anything is pushed

`gh` is authenticated as `winsznx` with `X-Oauth-Scopes: gist, read:org, repo`. **There is no
`workflow` scope.** GitHub rejects any push that creates or modifies a file under
`.github/workflows/`, and this repository's history contains two of them, so the *initial* push of
`main` is rejected.

This is a GitHub security control and must not be worked around — not by deleting the workflows,
not by rewriting history to exclude them, and not by pushing a branch that omits them. The one
remaining action is interactive and belongs to the repository owner:

```bash
gh auth refresh -h github.com -s workflow
```

Everything in this phase that does not require pushing proceeds regardless.

## Task map

| # | PRD task | Where | Status gate |
|---|---|---|---|
| 1 | Finalise README | `README.md` | a judge reproduces the product from a fresh clone using only what it says |
| 2 | Finalise architecture document | `docs/ARCHITECTURE.md` (new) | every box maps to a real package and a real file |
| 3 | Finalise threat model | `docs/THREAT_MODEL.md` | 33 threats, each with verification; updated by Phase 16 |
| 4 | Finalise runbook | `docs/RUNBOOK.md` | every command in it was run this session |
| 5 | Finalise demo script | `docs/DEMO_SCRIPT.md` | timings and expected markers match the current build |
| 6 | Finalise submission copy | `docs/SUBMISSION.md` (new) | every field answered or marked as an explicit checklist item |
| 7 | One-command or clearly sequenced setup | `README.md`, `Makefile` | the fresh-machine script is the executable form of the README |
| 8 | Verify `casting.yaml` and lock from a clean environment | `make signoz-reproducibility` | passed inside the clean clone |
| 9 | Verify images and packages pinned | same | passed |
| 10 | Licence files and third-party notices | `LICENSE`, `THIRD_PARTY_NOTICES.md` (both new) | `make scan-licences` exit 0 and every deployed container named |
| 11 | Declare AI assistant use | `README.md`, `docs/SUBMISSION.md` | stated plainly |
| 12 | Create tagged release | `v0.1.0` | after the push succeeds |
| 13 | Record final test outputs | `docs/evidence/phase-17-result.md` | exact counts, no rounding |
| 14 | Record final SigNoz resource links | `docs/evidence/phase-17/` | ten managed artefacts, read back |
| 15 | Fallback recording | after the live path works | only then |

## What this phase must not do

- Publish a URL that does not resolve.
- Claim a GitHub Actions run that has not happened.
- Claim a Railway deployment that is not serving.
- Delete or weaken a workflow, a check or a scan to make a push or a run succeed.
