# GitHub Actions — the first real runs

Both workflows had never executed on GitHub before this session. Phase 16's limitation 5 said so.
Running them found real defects, which is what they were for.

Repository: https://github.com/winsznx/flightrules

---

## Run 1 — `main`, the Phase 16 merge

| Workflow | Run | Result |
|---|---|---|
| CI | https://github.com/winsznx/flightrules/actions/runs/30208096343 | failure |
| Release gate | https://github.com/winsznx/flightrules/actions/runs/30208096352 | failure |

| Job | Result |
|---|---|
| Secret, licence and dependency scanning | **success** |
| Format, lint, typecheck, build | failure |
| Unit and property tests | failure |
| Clean install from committed manifests | failure |
| Database integration tests | failure |
| SigNoz deployment and MCP integration | failure |

### Defect 1 — jobs that run tests without building (fixed)

```text
Error: Failed to resolve entry for package "@flightrules/telemetry".
The package may have incorrect main/module/exports specified in its package.json.
 ❯ apps/demo-services/order-service/src/app.ts:1:1
```

Every workspace package resolves through its `exports`, which point at `dist/`. Installing builds
nothing, so the `unit`, `database` and `signoz` jobs failed at import. Locally `dist/` is always
warm, which is why only a real CI run could surface it — the same defect class as `make db-migrate`
on a clean clone, found by the Phase 16 reproducibility test.

**Fixed** in `fix(ci): build the workspace before the suites that import it through dist`. The three
jobs now build first.

## Run 2 — `phase/17-release`, after that fix

| Workflow | Run | Result |
|---|---|---|
| CI | https://github.com/winsznx/flightrules/actions/runs/30208393467 | failure |
| Release gate | https://github.com/winsznx/flightrules/actions/runs/30208393459 | failure |

The three jobs no longer fail at import. Every remaining failure is now the **same single cause**,
which is defect 2.

### Defect 2 — `next build` fails on Linux runners, silently (OPEN)

```text
▲ Next.js 16.2.11 (Turbopack)
  Creating an optimized production build ...
✓ Compiled successfully in 3.6s
  Skipping validation of types
 ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL  @flightrules/web@0.1.0 build
Exit status 1
```

Compilation succeeds. Then, **47 milliseconds later**, the process exits 1 having printed nothing.
No stack, no message, no page named.

What has been established:

- It is not pnpm's output multiplexing. A step was added that builds `@flightrules/web` alone, with
  its stderr attached, and the output is identical.
- It is not an ordering race. `packages/ui build: Done` precedes `apps/web build$` in the log.
- It is not the missing `dist/` of defect 1 — the build step now runs after a successful workspace
  build in the jobs that need one, and the standalone step runs after `typecheck`.
- It is platform-specific. The identical command, at the identical commit, succeeds on macOS 27
  `arm64` with Node 24.14.1 — including inside a clean clone with destroyed volumes, where
  `make verify` exits 0 with 1,416 tests.
- The interval is far too short for a prerender or an out-of-memory kill; it is the point at which
  Next spawns its page-data worker.

`next build --webpack` is **not** a usable alternative as configured: it cannot resolve the `@/*`
path alias, because `apps/web/tsconfig.json` declares `paths` without `baseUrl`. Turbopack resolves
it; the webpack builder does not. Adding `baseUrl` would be a one-line change, but it would be a
change made blind — it addresses the alias, not the silent exit, and there is no evidence yet that
the webpack path builds on Linux either.

**This is recorded as open rather than worked around.** The options that would turn CI green without
understanding it — removing the build step, marking the job `continue-on-error`, or deleting the
workflow — are exactly the false green this project exists to prevent, and the operating contract
forbids all three.

### What the runs did prove

- The secret, licence and dependency scanning job **passes on GitHub**, including the dependency
  audit that Phase 16 repaired. That gate had never run either.
- The `clean-install` job's lockfile check passes: `pnpm install --frozen-lockfile` does not modify
  `pnpm-lock.yaml`.
- The bootstrap password fix was necessary and is not yet exercised — the SigNoz job fails at the
  build step, before it reaches `scripts/bootstrap-signoz.sh`. Phase 16 established from the
  rejection body that the previous value, `ci-<run_id>`, could never have registered a first user,
  so that job could not have passed regardless.

## Next action

Diagnose the silent `next build` exit on `ubuntu-latest` with Node 24.14.1 and Next 16.2.11. The
most direct route is a runner with `NEXT_PRIVATE_DEBUG_CACHE`/`--debug` output or a `tmate` session,
neither of which was reached in this session.
