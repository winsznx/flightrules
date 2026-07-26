# Contributing

## Before anything else

Read [CLAUDE.md](CLAUDE.md). It is the operating contract this repository was built under, and it is
not decorative: it records the runtime facts that bite, the determinism boundary, and the rules about
what may be used as evidence. [docs/PRD.md](docs/PRD.md) is authoritative where the two disagree.

## Getting set up

```bash
make verify-env      # Node 24.14.1, pnpm 10.33.0, Docker, git, foundryctl v0.2.16
make install         # from the committed lockfile
```

The full path from a clean clone to a working demo is in the [README](README.md), and
`scripts/verify-fresh-machine.sh` is its executable form — if you change the setup sequence, change
that script too, and run it.

## The rules that are actually enforced

`make verify` runs the whole gate: format, lint, typecheck, unit tests, build, contract validation,
design-token check, secret scan and licence scan. It must exit 0 before anything is merged.

| Rule | Enforced by |
|---|---|
| No `any`, no `@ts-ignore`, no `@ts-expect-error` | `make typecheck`, review |
| No colour, size or font outside `design.md` | `make scan-design` |
| No secret in the tree or in history | `make scan-secrets`, `make scan-history` |
| Only permissive dependency licences | `make scan-licences` |
| No critical or high dependency advisory | `make scan-deps` |
| Every contract document valid | `make contract-validate` |

## The determinism boundary

These must stay deterministic and testable without a model: span normalisation, trace
reconstruction, route fingerprinting, route-family mining, graph comparison, contract parsing,
contract validation, rule evaluation, violation generation, the release-gate decision, and the CLI
exit status.

A model may explain evidence or suggest contract wording. **It must never decide whether a rule
passed.** Identical traces must produce identical graph fingerprints; use stable ordering and
canonical serialisation everywhere.

## Evidence, not assertion

A change is not done because the code exists. It is done when a test covers it and — where the
behaviour is a runtime one — something was observed against the running system. In particular:

- every MCP write is followed by a read-back that compares the fields that matter;
- a successful call is never treated as proof the resource is correct;
- a mock is for a unit test or a deterministic offline fixture, never a substitute for an
  integration this repository claims to have.

## Tests

```bash
make test               # unit and property tests, no external service
make test-integration   # real PostgreSQL and a real SigNoz deployment
make test-e2e           # the built product in a browser
```

Two facts cost an hour each if you learn them the hard way, and both are properties of suites that
talk to real services:

1. **Stop the worker before `make test-integration`.** It competes with the runner tests.
   `pkill -f 'apps/worker/dist/index.js'`.
2. **The integration suites drop the schema, and `make test-e2e` resets the demo.** Run
   `make demo-full` after them.

`docs/RUNBOOK.md` has the complete list.

## Commits

Conventional, focused, and specific about what changed:

```text
fix(normaliser): stop a negative attempt index subtracting from the retry budget
```

Not `update`, `fix stuff`, `final`, or `changes`. No co-author trailers.

## Adding a rule type, a metric or an attribute

- A new contract rule type needs: a schema, an evaluator, a passing case, a violating case, an
  insufficient-evidence case, and an entry in PRD section 10.4's order.
- A new telemetry attribute needs an entry in `docs/research/otel-attributes.md` with its stability,
  cardinality risk and privacy classification.
- A new external technical claim — an endpoint, a field, a package behaviour — needs an entry in
  `docs/research/source-lock.md` recording the source, the claim, and whether it was confirmed
  against the installed runtime. A blog post is never the sole basis for a decision.
