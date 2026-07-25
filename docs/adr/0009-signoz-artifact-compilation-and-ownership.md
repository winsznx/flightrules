# ADR-0009 — SigNoz artifact compilation, ownership and verification

- Status: accepted
- Date: 2026-07-25
- Phase: 10
- Supersedes: nothing. Extends ADR-0003 (SigNoz access boundary) and ADR-0008 (persistence and jobs).

## Context

PRD Phase 10 requires an active contract to produce *working, verified* SigNoz views, a dashboard
and alerts — "rather than decorative copies inside FlightRules". Operating-contract rule 13 requires
every MCP write to be followed by a read-back that validates the fields that matter, and rule 14
requires every generated dashboard panel to return real data after the seeded demo runs.

The pinned surface is SigNoz v0.134.0 and SigNoz MCP Server v0.9.0. Every decision below was made
against the running server, not against documentation.

## Decisions

### 1. Compilation is a pure function; the MCP conversation is not

`packages/artifact-compiler` turns (project, agent, contract version, artifact configuration) into
ten desired artefact specifications, their `spec_hash` values and the field paths a read-back must
agree on. It performs no I/O, reads no clock, and iterates nothing whose order a database chose.
The same inputs therefore produce byte-identical specifications, which is what makes "a second
identical sync creates none and updates none" decidable without asking SigNoz.

`apps/worker/src/artifact-sync.ts` holds everything that cannot be pure: listing, writing, reading
back and persisting. It contains no algorithm — it calls `compileArtifacts`, `planSync` and
`verifyResource`.

### 2. Ownership is the register, not the name

A managed name (`FlightRules / <project> / <agent> / <Label>`, PRD section 16.8) identifies an
artefact. It does **not** establish ownership. A resource carrying a managed name that
`signoz_artifacts` has never recorded belongs to whoever created it, and FlightRules reports a
`conflict` rather than overwriting it. Ownership is transferred only by a successful create that
the register records.

Conversely, once FlightRules owns a name it owns the whole resource: an edit made by hand is
restored on the next sync, because a contract that says one thing and a view that shows another is
worse than either alone. The managed description on every artefact says so in the SigNoz UI.

### 3. `signoz_update_view` is not used

It corrupts the stored query and takes every saved view in the tenant down with it (SL-057),
reproducibly, whatever body it is given. `signoz_update_dashboard` and `signoz_update_alert` were
tested the same way and are correct.

A saved view is therefore replaced by delete-then-create. The cost is a new resource identifier,
which the register records; the benefit is that FR-013 is delivered without faking the capability
and without leaving a landmine that breaks an unrelated user's saved views. This is the smallest
honest alternative, and the defect is recorded rather than hidden.

### 4. A read-back compares the fields that matter, never the whole resource

SigNoz rewrites what it stores: it normalises `fieldContext: "tag"` to `"attribute"` on a saved
view's `selectFields`, assigns its own UUID to each dashboard widget's `query.id`, adds fields to
`order[].key`, and populates timestamps and authorship. Comparing serialised bodies would fail
every verification for differences the server itself introduced.

Each artefact therefore declares its **material fields** — the name, the explorer page, the filter
expression, every panel title and identifier, the alert threshold, operator and channel — and only
those are compared. A mismatch fails the job.

### 5. The register records the attempt, not only the success

`persistArtifactWrites` runs in its own transaction *before* the commit function. The commit
transaction is rolled back when a job fails, and a rolled-back mismatch record is no record at all.
This is a deliberate departure from ADR-0008's "a handler never writes outside its commit function":
the whole point of the verification record is to survive the failure that produced it.

### 6. Delivery is reported, never assumed

`signoz_create_notification_channel` performs a real test delivery and reports the outcome (SL-055).
FlightRules records `deliveryTested` and `deliveryVerified` verbatim and never infers delivery from
a created channel. The default destination is a local webhook that nothing is listening on, so the
default configuration produces a recorded delivery *failure*. Alert **firing** is proven from alert
history and does not depend on the destination at all.

### 7. FlightRules' own telemetry is a Phase 10 precondition

Six of FR-014's ten panels and all four FR-015 alerts read `flight_rules.*` metrics. Those metrics
had never reached SigNoz, because `bootstrapFromEnv` never opened a metric pipeline (SL-053), and
PRD section 17.3's evaluator spans were declared but never created. Both were fixed here, because a
panel with no data is precisely the decorative artefact the exit gate forbids.

`flight_rules.duplicate_side_effects` was declared and never recorded. "Duplicate side effect" now
has one deterministic definition, in `packages/contract-engine`: an over-cardinality violation
against a rule whose selector pins it to `agent.side_effect` in (`write`, `external`).

## Consequences

- A contract activation is the only thing that shapes the operational surface. Nothing else writes
  a managed resource.
- Re-syncing an unchanged contract is free: no MCP write at all, only a read-back per artefact.
- A saved view's resource identifier changes whenever its specification changes. Anything that
  bookmarks a view URL must re-read it from the register.
- The register is the audit trail for the SigNoz surface: what was intended, what was found, and
  what was done about it.

## Alternatives rejected

- **Trusting the create response.** Forbidden by rule 13, and demonstrably wrong: the server accepts
  an incomplete widget "best-effort" and stores something other than what was asked for (SL-059).
- **Comparing whole resources.** Fails on every server-side normalisation; would make verification
  noise rather than signal.
- **Deleting stale artefacts automatically.** A superseded artefact is *reported* as stale. Deleting
  a resource an operator may have come to rely on, without being asked, is not ours to do.
- **Skipping saved views because their update tool is broken.** That would silently downgrade
  FR-013. Delete-then-create delivers the requirement and records the defect.
