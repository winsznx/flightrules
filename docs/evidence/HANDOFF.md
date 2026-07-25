# FlightRules handoff — after Phase 08

Written: 2026-07-25. `main` is green and the working tree is clean.

This replaces the previous handoff. Verify every claim below against the repository before relying
on it. The previous handoff needed no corrections; its one inaccuracy was already fixed in it.

---

## Phase status

| Phase | Status | Phase commit | Merge commit |
|---|---|---|---|
| 00 Source lock and feasibility proof | PASS | `ba600b8` | `1f87df2` |
| 01 Repository foundation and CI | PASS | `9e093da` | `d9052ff` |
| 02 SigNoz deployment through Foundry | PASS | `bb50031` | `3b878ab` |
| 03 Deterministic demo system | PASS | `9a37a88` | `fa172fe` |
| 04 OpenTelemetry instrumentation | PASS | `4d392b0` | `a4101ca` |
| 05 SigNoz MCP client and capability layer | PASS | `074a35a` | `9eda536` |
| 06 Trace graph and normalisation engine | PASS | `7b8e2aa` | `5949148` |
| 07 Contract schema and deterministic evaluator | PASS | `ca4225b` | `12e133b` |
| 08 Baseline mining and contract proposal | PASS | `7706e79` | `494fd8a` |
| 09–17 | NOT STARTED | — | — |

## Verified state

Every command below was run against the live stack on `main` after the Phase 08 merge.

```text
make verify              exit 0
make signoz-verify       exit 0
make contract-validate   exit 0, 20 contract documents valid
make test                862 passed, 0 failed, 0 skipped   (38 files)
make test-integration     91 passed, 0 failed, 0 skipped   ( 6 files)
                         ---
                         953 tests passed
make demo-v1             exit 0 (DEMO_RUNS=25 seeds a batch)
make demo-v2             exit 0
make mine-demo-baseline  exit 0
```

Integration breakdown: 8 database, 83 SigNoz. All fail rather than skip when their dependency is
absent.

## What Phase 08 added

One package, exactly as PRD section 13 names it.

### `packages/baseline-miner`

Storage-independent, because PRD sections 14.7 and 14.8 are Phase 09. It produces the values those
rows will hold and returns them.

Trace selection with PRD section 8.7's controls and progress states; bounded batch retrieval whose
field types are confirmed against the live SigNoz catalogue before it queries; fifteen typed exclusion
reasons with counts that must reconcile or mining fails; exact fingerprint grouping; integer statistics
with nearest-rank percentiles; representative selection and rare marking; PRD section 8.8's four review
actions; rule proposal across nine rule types with an evidence basis on every rule; and deterministic
draft YAML whose round trip through the public parser is proven by content hash.

**The exit gate is proven live**: 34 fresh `refund-agent-v1` runs became one route family at the
fingerprint the committed Phase 07 contract already approves, a human approval was recorded, a 28-rule
draft contract was generated and accepted by the Phase 07 validator through the published CLI, a freshly
executed known-good run passed it with 0 violations, and the canary failed it with 10 violations
including three critical zero-tolerance ones naming the missing policy check, the missing fraud check
and the duplicate refund. No model participates in any decision. Nothing is activated.

Reproduce with `DEMO_RUNS=25 make demo-v1 && make demo-v2 && make mine-demo-baseline`. The output is
committed at `docs/evidence/phase-08/mining-run.log` and the generated contract at
`docs/evidence/phase-08/mined-contract.yaml`.

## Important discoveries

New source-lock entries this session: **SL-050 and SL-051**.

| ID | Finding |
|---|---|
| SL-050 | `nextCursor` is empty exactly when a Query Builder page is **not full**, and a non-empty opaque token when it is — including when the limit happens to equal the total row count. That is the only truncation signal the pinned server offers. Offset paging under `order: timestamp asc` was verified to produce disjoint pages that concatenate exactly to the unpaged result. Note the asymmetry: a full page is *not* evidence that more rows exist. |
| SL-051 | `signoz_get_field_keys` with no `searchText` returns the whole trace field catalogue in one response (40 keys, `complete: true`) with a `fieldDataType` per field — so the server itself can confirm the type a request should declare, which closes SL-046 by discovery rather than by a hand-maintained list. But it omits `timestamp`, omits every resource attribute, reports custom span attributes as `attribute` where `selectFields` needs `tag`, and reports two keys with an empty type. |

## Defects found and fixed

Both were found by a test, not by inspection.

1. **The proposal generator prefixed a route fingerprint with `sha256:` twice**, so the generated
   document carried `sha256:sha256:<hex>` and the validator rejected it with `INVALID_FORMAT`. The fix
   is not just removing one prefix: a proposed rule now holds the **validated** bare form the evaluator
   compares against, and the prefix is added once by the document renderer for a human reader.
2. **A rule identifier was derived from the raw canonical label while its selector was derived from the
   sanitised one.** For an ordinary label the two agree; for one carrying a control character they do
   not, and two labels that sanitise to one selector value would have produced two rules governing the
   same spans. Both now derive from one sanitised name, resolved once per mining run. Where two labels
   collide, **neither** gets a rule and both are disclosed as `LABEL_NOT_EXPRESSIBLE` — a selector can
   only say `name: X`, so a rule for either would also govern the other.

## Judgement calls to preserve

These are decisions with reasons, recorded so a later phase does not undo them by accident. ADR-0007
holds the full set.

1. **A cardinality bound is the p95 of the observed per-run counts when the maximum exceeds it.** PRD
   FR-008's "maximum observed cardinality" read literally would encode an accidental duplicate refund as
   permitted policy — the exact fault the product exists to catch. The outlier is disclosed and flagged
   for human confirmation instead.
2. **A step is proposed as required only when every observable approved run performed it.** A step
   present in some runs and provably absent in others is bounded and disclosed as optional. A proposal
   must never contain a rule its own baseline violates.
3. **A remote handler is required through the edge from its caller, not by its own presence.** Phase
   04's aborted payment attempt is the case: the client span exists and the handler span was never
   exported, so `required_span` on the handler would report a skipped step for a telemetry gap.
4. **An absence inside an unobservable subtree is not an absence.** The scoping is per subtree at label
   granularity, matching ADR-0006 decision 8. A run that lost one handler span still proves the absence
   of a step that would have run elsewhere in it.
5. **A retried side effect's allowance is never widened by a margin.**
6. **Absent telemetry is never a bound of zero.** The demo emits no token telemetry, so both token
   budgets come back `ATTRIBUTE_NOT_EMITTED` and are disclosed rather than proposed.
7. **A truncated dataset cannot found a baseline**, even when it holds enough runs, because the runs it
   omitted are exactly the ones nobody looked at.
8. **Deduplication is by run identifier**, never by order, customer or fingerprint.
9. **`forbidden_span` and `forbidden_path` are never proposed.** Neither can be derived from
   observation; naming a domain the agent never touched would be an invention.

## Unresolved limitations

1. **A proposal is deliberately broader than a hand-written contract** — 28 rules and 9 zero-tolerance
   identifiers against the demo, where the Phase 07 contract has 15 and 4. Every rule is evidence-backed
   and a reviewer is expected to prune. `order.lookup` becoming a critical prerequisite is the clearest
   case: every approved run did look the order up before refunding, so the evidence is real, and whether
   skipping it should fail a release is a judgement the miner does not make.
2. **The generated contract's similarity figure differs from Phase 07's.** The canary scores 0.619047
   against the generated contract and 0.572815 against the hand-written one, because PRD section 11.9
   weights critical nodes and the two contracts mark different labels critical. Both are correct for
   their own contract; do not "fix" either number.
3. **Nothing from Phase 08 is persisted, and no HTTP API is exposed.** PRD sections 14.7, 14.8 and 15.5
   are Phase 09. `selectionHash` and the derived baseline and family identifiers exist so a repeated job
   is recognisable when persistence arrives.
4. **The Phase 04 aborted server span is still unresolved, by design.** Phase 07 gives it a correct
   evaluation outcome and Phase 08 gives it a correct mining outcome; the cause is a Phase 16
   investigation item.
5. **Sibling temporal ordering is still not expressible in P0** (Phase 07 limitation, unchanged), so no
   proposal contains a "fraud before refund" rule — only "fraud present" and "refund descends from the
   workflow root".
6. **Release-scoped budgets remain `deferred`** at run scope until the Phase 11 aggregation.
7. **A dataset larger than 5,000 traces is refused rather than sampled**, because sampling would make
   every support ratio describe a subset the caller did not choose.
8. **Metrics and logs are declared but not emitted** (Phase 04 limitation, unchanged). Acceptance scope
   item 6 stays `IN PROGRESS`; emitting them is Phase 09 work.
9. **`signoz_update_*` wrappers are not implemented**, and dashboard and alert read-back verification is
   untested. Both are Phase 10 scope by PRD assignment.
10. **Span links and explicit predecessors are modelled but never populated** — the demo emits neither.
11. **The capability snapshot is exposed but not persisted** (Phase 05 limitation; needs Phase 09).
12. **Node timestamps are millisecond-accurate** (SL-044), so the mined latency percentiles inherit that
    resolution.

---

## Next phase: 09 — Application core, API, jobs, and persistence

PRD section: line 3164. Read it in full, together with section 14 (the data model, lines 1941–2198),
section 15 (the API surface, lines 2199–2324), section 19 (the error model), FR-001, FR-002, FR-018,
FR-019 and FR-020.

### Entry criteria — all SATISFIED

| Criterion | Evidence |
|---|---|
| Phase 08 merged and green | `494fd8a`; `make verify` exit 0 on `main` |
| A deterministic miner produces the baseline rows | `packages/baseline-miner`, proven live on 34 runs |
| A validated contract format and a deterministic evaluator exist | `packages/contract-schema`, `packages/contract-engine` |
| Every lifecycle value Phase 09 must store already exists as a typed value | `BaselineVersion`, `RouteFamily`, `ContractProposal`, `RunEvaluation`, `Violation` |
| A migration system with an applied history exists | `packages/db`, migrations `0001` and `0002` |
| Typed error codes cover the lifecycle | `packages/domain/src/errors.ts` — 23 codes including `BASELINE_INSUFFICIENT_RUNS` and `JOB_ALREADY_RUNNING` |
| An idempotency key for a long-running job exists | `selectionHash` on every mined baseline |
| Telemetry instruments exist for the API and the worker | `packages/telemetry` |

### Scope

Branch `phase/09-application-core`. PRD section 13 names `apps/api`, `apps/worker` and `apps/cli`;
Phase 09 owns the first two and the persistence layer, while `apps/cli` is Phase 11.

PRD Phase 09 lists twelve tasks: all P0 database tables and migrations, projects and agents, the SigNoz
connection setup, jobs with idempotency, baselines and route decisions, the contract lifecycle,
evaluations and violations, audit events, progress events, the typed error envelope, API documentation
generated from source, and request identifiers with tracing.

The exit gate: **all product state survives process restarts and can be driven without the UI.**

### Facts that will matter

- **Do not edit migrations `0001` or `0002`.** `0002` fixes same-millisecond UUIDv7 ordering using
  RFC 9562 Method 3; go through the established generation path rather than around it.
- The sixteen tables of PRD section 14 are the P0 set. `baseline_versions` and `route_families` map
  directly onto `BaselineVersion` and `RouteFamily`; `contracts` and `contract_rules` map onto
  `ContractProposal` and `ProposedRule` including `evidence_basis_json`.
- `mineBaseline` takes a `TraceSource`, so the worker supplies `signozTraceSource(operations, context)`
  and a test supplies a fixture source. No new abstraction is needed for the job runner.
- `MINING_STAGES` is already PRD section 8.7's five progress states, and `mineBaseline` reports them
  through `onProgress` — that is what PRD Phase 09 task 9's progress events should carry.
- `selectionHash` is the idempotency key for a baseline job (PRD sections 18.2 and 20.1). A repeated
  request with an identical selection produces the same `baselineIdentifier`.
- PRD FR-018's lifecycle is `draft -> approved -> active -> superseded`. Phase 08 produces `draft` and
  nothing else; activating a version must supersede the prior active version for the same agent and
  environment while preserving every historical evaluation.
- `canonicalContract` sorts its own input, so a contract arriving from a database row hashes the same as
  one arriving from YAML.
- The evaluator is storage-independent by design; persist its output, do not change it.
- Every MCP write needs a read-back (operating contract rule 13). That bites in Phase 10, not here.
- Declare `dataType` for every non-string tag in any new `selectFields` (SL-046), and confirm it against
  the catalogue (SL-051). `verifyFieldTypes` already does both.
- New packages and apps must be added to `tsconfig.build.json` references.
- Biome forbids `console.*` except `error` and `warn`; scripts use `process.stdout.write`.
- Biome rejects `(maybe?.x as T).y`; assert the value is present first.
- A raw control character in a source file makes `grep` treat the whole file as binary and
  suppress every match. Write such characters as JavaScript escapes (`\u0001`, `\u202e`) in
  tests, as `packages/baseline-miner/src/safety.test.ts` does.
- Run `make contract-validate` after touching any contract document; it now covers 20 documents,
  including the one the miner generated under `docs/evidence/phase-08/`.
- Source `.env` before any integration test or script: `set -a && . ./.env && set +a`.
- Integration tests need a demo run within the last six hours. `DEMO_RUNS=25 make demo-v1` seeds a
  batch through the agent's `/agent/seed` endpoint.
- The v1 route fingerprint is
  `43070aa4af4f6c2c912a8d7bcc724f1d199e0425dc8ad7256b528eec195cb037`; v2 is
  `22ffa0c0e578ef70a32a34aae7830f40aeef027aae28e66006601e80f99c7466`.
