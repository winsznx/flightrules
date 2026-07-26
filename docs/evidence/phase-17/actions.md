# GitHub Actions — the first real runs

Both workflows had never executed on GitHub before this phase. Phase 16's limitation 5 said so.
Running them found three real defects, which is what they were for. Every one of them was invisible
on macOS and fatal on a runner, and none of them would have been found by any amount of local
testing.

Repository: https://github.com/winsznx/flightrules

---

## Run 1 — `main`, the Phase 16 merge

| Workflow | Run | Result |
|---|---|---|
| CI | https://github.com/winsznx/flightrules/actions/runs/30208096343 | failure |
| Release gate | https://github.com/winsznx/flightrules/actions/runs/30208096352 | failure |

### Defect 1 — jobs that run tests without building (fixed)

```text
Error: Failed to resolve entry for package "@flightrules/telemetry".
 ❯ apps/demo-services/order-service/src/app.ts:1:1
```

Every workspace package resolves through its `exports`, which point at `dist/`. Installing builds
nothing, so the `unit`, `database` and `signoz` jobs failed at import. Locally `dist/` is always
warm, which is why only a real CI run could surface it.

Fixed in `fix(ci): build the workspace before the suites that import it through dist`.

## Run 2 — `phase/17-release`

| Workflow | Run | Result |
|---|---|---|
| CI | https://github.com/winsznx/flightrules/actions/runs/30208393467 | failure |
| Release gate | https://github.com/winsznx/flightrules/actions/runs/30208393459 | failure |

Every remaining failure had the same single cause: defect 2.

### Defect 2 — `next build` exits 1 in silence (fixed, SL-067)

```text
▲ Next.js 16.2.11 (Turbopack)
✓ Compiled successfully in 3.6s
  Skipping validation of types
 ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL  @flightrules/web@0.1.0 build
Exit status 1
```

Compilation succeeded. Forty-seven milliseconds later the process exited `1` having printed nothing:
no stack, no message, no page named.

**How it was found.** A dispatch-only workflow on a disposable `diagnose/**` branch ran the same
command on `ubuntu-latest` under `NODE_OPTIONS=--trace-exit`, which prints a stack trace whenever
`process.exit()` is called. It produced the entire diagnostic output the failure had to offer:

```text
(node:2930) WARNING: Exited the environment with code 1
    at exit (node:internal/process/per_thread:241:13)
    at .../next/dist/build/type-check.js:110:17
```

**The cause, in three parts.**

1. `next/dist/lib/has-necessary-dependencies.js` resolves `typescript/package.json` and then checks
   the filesystem for `<packageDir>/lib/typescript.js`. TypeScript 7.0.2 ships a native compiler and
   has no such file, so Next reports `typescript` as **missing** while `tsc` works perfectly.
2. `next/dist/lib/verify-typescript-setup.js` branches on `ci-info`. Off CI it silently reinstalls
   TypeScript on **every** build. With `CI` set it calls `missingDepsError`, which throws `E552`
   **without logging anything**.
3. `next/dist/build/type-check.js:110` catches that rejection and calls `process.exit(1)` with the
   comment *"the error is already logged in the worker"*. No worker exists when
   `typescript.ignoreBuildErrors` is set, because the implementation then runs in-process. Nothing
   is ever printed.

**It is not platform-specific.** `CI` is the discriminator. The failure reproduces on macOS 27
`arm64` with `CI=true` at the identical commit and disappears with `CI` unset. The build had simply
never run with `CI` set before GitHub Actions ran for the first time.

**The fix.** `apps/web` pins `typescript@5.9.3`, the major Next.js 16.2.11 supports; the rest of the
workspace stays on `7.0.2`. With TypeScript detectable, Next runs its own type-check worker, so
`typescript.ignoreBuildErrors` was **removed** — the application now passes `tsc --noEmit` *and*
Next's own step, including the route-type validation the suppression had also been disabling.
`apps/web/src/web.test.ts` runs Next's own dependency probe with Next's own required-package list, so
the regression cannot be silent again.

Recorded as SL-067, superseding SL-060.

## Run 3 — after the build fix

| Workflow | Run | Result |
|---|---|---|
| CI | https://github.com/winsznx/flightrules/actions/runs/30216007760 | failure — one job |
| Release gate | https://github.com/winsznx/flightrules/actions/runs/30216007765 | failure |

Five of six CI jobs passed, including the static job that had never got past `next build`.

### Defect 3a — a job whose suite's preconditions it never provided (fixed)

The `integration-signoz` project is not a SigNoz-only suite. Every file states its prerequisites in
its own header: a deployed SigNoz, a **migrated database**, and a **recent demo batch**. The job
supplied only the first, so the phase-09, phase-10 and phase-11 gates had no database and the graph,
mining and evaluation suites had no traces. It could not have passed on any runner.

The job now provides the substrate the suite documents.

### Defect 3b — the demo topology collided with the job's own database (fixed)

```text
Error response from daemon: driver failed programming external connectivity on endpoint
flightrules-postgres: Bind for 0.0.0.0:5433 failed: port is already allocated
```

`compose.app.yaml` publishes the application's PostgreSQL on host port 5433, which both workflows
already provide as a service container on the same port. Both now start the six demo services by
name. Locally there is no service container and `make demo-up` still starts everything.

## Run 4 — the failure that named nothing

| Workflow | Run | Result |
|---|---|---|
| CI | https://github.com/winsznx/flightrules/actions/runs/30216382470 | failure — SigNoz job |
| Release gate | https://github.com/winsznx/flightrules/actions/runs/30216382485 | failure |

The demo topology started, the demo runs returned real trace identifiers, SigNoz was healthy, an
OTLP `POST /v1/traces` from inside a demo container returned **200** — and no `refund-agent-v1`
trace ever became queryable. Baseline mining reported `insufficient_runs` with `familyCount: 0`
eight times in a row, which reads as *"the telemetry has not caught up yet"*.

### Defect 4 — `host.docker.internal` was mapped for five services out of six (fixed, SL-068)

The readiness probe was changed to say what SigNoz actually holds when a release never appears,
rather than only that it did not. That single change ended the search:

```text
refund-agent-v1 never became queryable after 20 attempts.
5 span(s) in the window
  services:     flightrules-fraud-service, flightrules-notification-service,
                flightrules-order-service, flightrules-payment-service, flightrules-policy-service
  span names:   customer.notify.handler, fraud.check.handler, order.lookup.handler,
                payment.refund.handler, policy.retrieve.handler
  release ids:  (unset)
```

Five spans: one server span per service, no client spans, no root, no release identifier — and
**no `flightrules-demo-agent`**. Probing the two containers side by side in one job:

| From | `getent hosts host.docker.internal` | OTLP `POST /v1/traces` |
|---|---|---|
| `payment-service` | `172.17.0.1` | **200** |
| `demo-agent` | *(nothing)* | **`TypeError: fetch failed ENOTFOUND`** |

`compose.app.yaml` declared `extra_hosts: ["host.docker.internal:host-gateway"]` on five of its six
demo services. Docker Desktop injects that name on macOS whether or not a service declares it, so
the omission was invisible for sixteen phases. Linux does not.

The agent is the only process that emits the root `refund.request` span and the `agent.release.id`
attribute every contract rule is keyed on. With its exporter dead, the five services' server spans
still arrived — as parentless roots carrying no release identifier. Ingestion returned 200, SigNoz
was healthy, the demo returned a real trace identifier, and every query for a run came back empty.

**The fix** is the missing mapping. `packages/test-fixtures/src/release-gate-workflow.test.ts`
asserts the invariant over the whole file — any service pointing at `host.docker.internal` must map
it — and was confirmed to fail when the mapping is removed.

Recorded as SL-068.

---

## What the runs proved along the way

- The secret, licence and dependency scanning job passes on GitHub, including the dependency audit
  Phase 16 repaired. That gate had never run either.
- `pnpm install --frozen-lockfile` does not modify `pnpm-lock.yaml`.
- Phase 16's bootstrap-password fix was necessary: the SigNoz job now reaches
  `scripts/bootstrap-signoz.sh` and registers a first user on the first attempt.
- Foundry casts the pinned SigNoz stack on `ubuntu-latest` and every surface verifies.

## The instruments, and their removal

Three temporary probes were used, all on a disposable `diagnose/**` branch that no required workflow
watches, all dispatch-only, and all deleted before the release tag: a `--trace-exit` build probe, a
container-reachability probe, and a span-listing probe. None of them ever ran on `main` or on a phase
branch, and none of them could affect a required check.

No `continue-on-error`, no `|| true` around a gate, and no deleted assertion was used at any point.
