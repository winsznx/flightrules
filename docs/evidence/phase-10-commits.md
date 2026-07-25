# Phase 10 commits

Branch `phase/10-signoz-artifact-compiler`, merged into `main` after every gate passed.

| Commit | Subject |
|---|---|
| `5f4de3e` | feat(artifact-compiler): compile an active contract into verified SigNoz artefacts |

The merge commit is recorded in `docs/evidence/HANDOFF.md`.

## Gates at merge

```text
make verify              exit 0
make signoz-verify       exit 0
make contract-validate   exit 0, 20 contract documents valid
make db-migrate          applied: 0004
make test                961 passed, 0 failed, 0 skipped   (44 files)
make test-integration    209 passed, 0 failed, 0 skipped   (13 files)
                         ---
                         1,170 tests passed
```
