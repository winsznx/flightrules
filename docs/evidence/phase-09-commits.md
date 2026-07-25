# Phase 09 commit record

Branch: `phase/09-application-core`

| Commit | Type | Subject |
|---|---|---|
| `222c7c0` | feat | `feat(app-core): persist the full lifecycle behind a stable API and a job worker` |
| `f8e3215` | merge | `merge(phase-09): application core, API, jobs, and persistence` |

Both are reachable from `main`. No co-author trailers. Migrations `0001` and `0002` were not
touched; `0003_application_core.sql` is forward-only.

## Verification at the merge commit

```text
make verify              exit 0
  make test              895 passed, 0 failed, 0 skipped   (42 files)
  make contract-validate  20 contract documents valid
  make scan-secrets      clean
  make scan-licences     282 packages, all permissive
make test-integration    exit 0
  integration-db          102 passed  (6 files)
  integration-signoz       89 passed  (6 files)
                         ---
                         1,086 tests passed
```

## Live evidence captured at this commit

```text
baseline    bl-cf6572c61a7a36b5f789198d0f8f1511   approved, 76 eligible runs, 1 family, not truncated
family      rf-15cfaaeb2a4bfab013cf954f397de3db   43070aa4af4f6c2c912a8d7bcc724f1d199e0425dc8ad7256b528eec195cb037
                                                  76 occurrences, 1.000000, not rare, approved
contract    refund-agent-local 0.1.0              active, mined, 28 rules, 9 zero-tolerance
                                                  aeab87797148c09bbd16dd55842e840c6cad91740a016800212c37a15319f7d2
evaluation  release  pass   5 runs   0 violations   0 zero-tolerance
evaluation  release  fail   4 runs  40 violations  12 zero-tolerance
jobs        baseline_mining succeeded, contract_proposal succeeded, evaluation succeeded x2
            every one on attempt 1
storage     80 trace_runs, 80 trace_graphs, 13 audit_events across 11 event types
```

Full dump: `docs/evidence/phase-09/live-state.txt`.
Schema inventory: `docs/evidence/phase-09/schema-inventory.md`.
