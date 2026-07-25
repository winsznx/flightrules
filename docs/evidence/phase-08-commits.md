# Phase 08 commits

Branch: `phase/08-baseline-mining`

| Commit | Type | Description |
|---|---|---|
| `7706e79` | `feat(baseline-miner)` | Deterministic route-family mining and the reviewable contract proposal |
| `494fd8a` | `merge(phase-08)` | Merge into `main` |

Phase 08 spans `7706e79 -> 494fd8a`. The evidence commit that records this file follows the merge on
`main`; it cannot name its own hash, which is why it is not listed here.

## Validation at the merge commit

```text
make verify              exit 0
make signoz-verify       exit 0
make contract-validate   exit 0, 20 contract documents valid
make test                862 passed, 0 failed, 0 skipped   (38 files)
make test-integration     91 passed, 0 failed, 0 skipped   ( 6 files)
                         ---
                         953 tests passed
make demo-v1             exit 0 (DEMO_RUNS=25)
make demo-v2             exit 0
make mine-demo-baseline  exit 0
```

Integration breakdown: 8 database, 83 SigNoz.

## Runtime validation at the merge commit

```text
field types        17 verified, 5 unverified, 0 mismatched
baseline           bl-cf3f1e336ce4de3a1ea727a856ba827a, status pending_review
counts             34 discovered, 34 retrieved, 34 eligible, 0 excluded, 1 family, 0 rare
family             43070aa4af4f6c2c912a8d7bcc724f1d199e0425dc8ad7256b528eec195cb037
proposal           draft, 28 rules, 9 zero-tolerance, hash 46b1d9ed...
validator          valid through the published CLI, round trip identical
v1 evaluation      pass, 27 passed, 1 deferred, 0 violations
v2 evaluation      fail, 10 violations, 3 critical zero-tolerance
repeated mining    baseline id, content hash and YAML all byte-identical
```

Full output: `docs/evidence/phase-08/mining-run.log`.
Generated contract: `docs/evidence/phase-08/mined-contract.yaml`.
