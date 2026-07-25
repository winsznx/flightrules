# ADR-0008 — Application core: persistence, jobs, and the API boundary

- Status: Accepted
- Date: 2026-07-25
- Phase: 09
- Supersedes: none
- Related: ADR-0006 (contract DSL and determinism boundary), ADR-0007 (baseline mining and proposal safety)

## Context

PRD Phase 09 exposes stable product APIs and persists the full lifecycle. Its exit gate is that all
product state survives process restarts and can be driven without the UI.

Everything deterministic already exists and is storage-independent by design: the normaliser, the
graph engine, the contract schema, the evaluator and the miner. Phase 09 must not reimplement any of
it, and must not weaken any of it by the way it stores the results.

## Decisions

### 1. Sixteen tables, and no seventeenth

PRD section 14 fixes the P0 table set at sixteen. Migration `0001` created three of them;
`0003` creates the other thirteen. Progress events, which PRD section 15.10 requires be retrievable
per job, are stored on the `jobs` row as an append-only array guarded by a monotonic index rather
than in a new table. A `job_events` table would have been more conventional and would also have been
a seventeenth table the PRD does not name.

### 2. Columns beyond PRD section 14, named rather than smuggled

Three kinds of column were added and each is visible in the schema rather than hidden inside a JSON
payload:

- **Job operations**: `max_attempts`, `input_hash`, `progress_index`, `progress_stage`,
  `progress_json`, `lease_owner`, `lease_expires_at`, `heartbeat_at`, `available_at`,
  `cancel_requested`, `updated_at`. PRD section 20.1 requires that worker restarts resume or safely
  fail jobs, which is not expressible without a lease.
- **Mining provenance**: `baseline_identifier`, `selection_hash`, `selection_json`, `counts_json`,
  `retrieval_json`, `excluded_json`, `disclosures_json`, `rare_threshold_*` on `baseline_versions`,
  and `family_identifier`, `rare`, `occurrence_numerator`/`_denominator` on `route_families`.
  ADR-0007 makes every one of these part of what a reviewer must see; dropping them would persist a
  conclusion without its evidence.
- **FR-002 fields**: `tool_operation_matcher_json` and `completion_criteria_json` on `agents`.
  FR-002 requires both and PRD section 14.3 lists neither.

### 3. A ratio is stored as its counts, and the decimal is checked against them

Every percentage in the product is an exact fraction rendered by truncated integer division
(ADR-0007 decision 3). A `numeric` column alone would lose the fraction; the fraction alone would
make the UI compute a number the domain already decided. So both are stored, and a check constraint
ties them together:

```sql
occurrence_percent = trunc(occurrence_numerator::numeric * 1000000 / occurrence_denominator) / 1000000
```

The same holds for `run_evaluations.similarity_score`. A row whose displayed share disagrees with
its own counts cannot be written.

### 4. A canonical graph is re-canonicalised on read

PostgreSQL `jsonb` orders object keys by length and then bytes. `canonicaliseGraph` orders a node's
attributes lexicographically, and `serialiseCanonicalGraph` writes that map through unchanged — so
attribute key order is part of the byte string the route fingerprint is taken over. A graph read
straight back out of a row would serialise differently from the one that produced the fingerprint
beside it.

`readCanonicalGraph` restores the order, and an integration test asserts byte equality of the
serialised form rather than assuming it. A contract needs no such treatment because
`canonicalContract` sorts its own input.

### 5. `selectionHash` is the baseline job's identity

PRD sections 18.2 and 20.1 require idempotency keys on long-running jobs. The miner already derives
a hash over everything that determines the dataset, so the API recomputes it by calling
`resolveSelection` and `selectionHash` rather than hashing a shape of its own. `jobs` carries
`unique (job_type, idempotency_key)`, so two identical requests are one job and one baseline.

`input_hash` exists for the case the key cannot cover: a repeat under the same key whose canonical
input differs is a conflict, not a silent reuse of someone else's result.

### 6. Claiming is `for update skip locked`, and the result commits with the success

The claim is one statement: `update ... where id = (select ... for update skip locked limit 1)`.
Two workers take different rows or one takes none; neither blocks. Verified against the running
PostgreSQL 16 by a test with two real connections rather than by reading the manual.

A handler never writes the job's outcome. It returns a *commit* function which the runner executes
inside the transaction that marks the job succeeded, so a crash between producing output and
recording success leaves nothing at all. The test for this deliberately writes a visible side effect
and then throws.

### 7. Progress is monotonic in SQL, not in the handler

`update ... where progress_index < :index`. A replayed event and an out-of-order event are both
no-ops that return `false` rather than throwing: at-least-once delivery is normal, and a handler
that failed on a duplicate would turn redelivery into a job failure.

### 8. A contract proposal re-mines rather than storing raw traces

`proposeContract` needs the runs themselves, not the canonical projection, and PRD section 14.5 is
explicit that raw traces are not stored and are refetched from SigNoz when needed. So the proposal
job re-mines the stored selection — which is deterministic in the selection — and then asserts that
the re-mined baseline identity and family fingerprints match what was reviewed. If a trace has aged
out of SigNoz the dataset has changed, and the job fails with `TRACE_INCOMPLETE` rather than
proposing from evidence nobody approved.

### 9. One active contract per agent and environment, enforced by a partial unique index

FR-018 says activating a version supersedes the prior active version for the same agent and
environment. The transaction supersedes first and then activates, both guarded on the state they
expect; the partial unique index is the second line of defence, so even a transition written
incorrectly cannot leave two active policies. Superseded contracts are never deleted, so every
historical evaluation still resolves the policy it was judged against.

### 10. Three error codes were added, and the addition is bounded

PRD section 19 opens with "Required error codes **include**", and its own guidance names outcomes
the API must distinguish — "not found", "validation failure", "illegal transition" — that no listed
code covers. `NOT_FOUND`, `VALIDATION_FAILED` and `STATE_TRANSITION_INVALID` were added. A test
asserts the PRD's twenty-three come first and unchanged, and that exactly these three follow.

`STATUS_BY_ERROR_CODE` is exhaustive by type, so adding a further code without deciding its HTTP
status is a compile error rather than a silent 500.

### 11. Documentation is generated from the declarations that serve the traffic

PRD Phase 09 task 11 asks for API documentation generated from source. Every route is declared once
with its Zod request and response schemas; the same declaration registers the handler, validates the
response, and produces the OpenAPI document through `z.toJSONSchema`. A hand-maintained document
drifts silently, and a specification that disagrees with the server is worse than none.

Validating the response against its declared schema at runtime is what makes the document a contract
rather than a description.

### 12. Routes the PRD assigns to a later phase are not registered

`POST /api/setup/signoz/sync-artifacts` and `POST /api/contracts/:id/sync-signoz` are Phase 10;
`GET /api/releases/:id/gate` is Phase 11; `GET /api/releases/:id/diff` is Phase 14. None is
registered, so a caller gets `404` rather than a stub that appears to work.

## Consequences

- The API never talks to SigNoz for anything long-running. Mining, evaluation and demo runs are jobs,
  so a repeated request is cheap and a restart is harmless.
- A worker with no handler for a job type does not claim it, which makes a heterogeneous fleet
  possible without configuration.
- The demo endpoints reuse the ordinary job path rather than having a path of their own, so the demo
  proves the product rather than a parallel implementation.
- Metrics are now genuinely emitted (PRD section 17.4, FR-016) through a typed recording surface
  whose dimensions are filtered against the declared spec at runtime as well as at the type level.

## Alternatives rejected

| Alternative | Why not |
|---|---|
| A `job_events` table | PRD section 14 fixes sixteen tables; the requirement is retrievability per job, which an append-only column satisfies. |
| Store the canonical graph as text to preserve bytes | Loses every `jsonb` query the Release Diff will need; re-canonicalising on read is provably transparent and keeps the column queryable. |
| Persist full trace graphs so a proposal never refetches | PRD section 14.5 explicitly stores canonical evidence and refetches raw traces; storing them would also grow without bound. |
| `on conflict do update` for job submission | Would touch the row of a job another worker is running. `do nothing` then read is the safe shape. |
| Advisory locks instead of a lease column | Invisible to an operator and lost on connection death without a recoverable record; a lease with an expiry is queryable and recoverable. |
| Offset pagination | A row inserted between two requests shifts every later page; PRD section 15 asks for cursors and the UUIDv7 key already gives a total order. |
| Let the API mine synchronously for the demo | A six-hour window over 50 traces is not a request; it is the job the rest of the product already models. |
