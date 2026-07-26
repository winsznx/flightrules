# Phase 16 task 2 — dependency, licence, secret and configuration scans

Run 2026-07-26 on `phase/16-hardening`, macOS 27.0 arm64, Node 24.14.1, pnpm 10.33.0.

Every scan below **ran**. That is not a formality: one of them had never run at all.

---

## Summary

| Scan | Tool and version | Command | Result |
|---|---|---|---|
| Dependency vulnerabilities | `scripts/audit-dependencies.mjs` against the npm advisory database, `semver@7.8.5` | `make scan-deps` | **exit 0** — 1 moderate, disclosed below; 0 high, 0 critical |
| Dependency licences | `scripts/check-licences.mjs` over `pnpm licenses list` | `make scan-licences` | **exit 0** — 302 packages, 17 licence expressions, all permissive |
| Secrets, working tree | `secretlint@13.0.4` with `@secretlint/secretlint-rule-preset-recommend` | `make scan-secrets` | **exit 0** |
| Secrets, git history | `gitleaks@8.30.1` | `make scan-history` | **exit 0** — 58 commits, 5.11 MB, no leaks |
| Workflow security | manual review of both workflows | — | no finding; see below |
| Dockerfile and deployment | manual review of `Dockerfile.demo`, `compose.app.yaml`, `casting.yaml` | `make signoz-verify`, `make signoz-reproducibility` | no finding; one documented local-mode note |

Container-image vulnerability scanning is **not** run: no scanner is installed on the supported
toolchain and none is pinned by the repository. The images FlightRules deploys are unmodified
upstream SigNoz releases pinned by digest-bearing tags in `casting.yaml.lock`, and
`make signoz-verify` asserts every running container's tag. Adding a scanner would be a new
unpinned tool in the reproducibility path; the honest position is that this control is **not
implemented** rather than implied.

---

## The dependency gate had never run

`package.json` declared `"scan:deps": "pnpm audit --audit-level high"`, and the `security` job of
`.github/workflows/ci.yml` calls it. It fails 100 % of the time:

```text
$ pnpm audit --audit-level high
 ERROR  Unexpected token '', "…"... is not valid JSON
    at JSON.parse (<anonymous>)
    at _Response.json (…/pnpm.cjs:38655:21)
    at async Object.handler [as audit] (…/pnpm.cjs:137402:23)
```

Three consecutive runs, all exit 1. `pnpm@10.33.0` requests the advisory endpoint with
`accept-encoding: gzip`; Cloudflare, which fronts `registry.npmjs.org`, returns the body
gzip-encoded **without** a `content-encoding` header, and pnpm hands the still-compressed bytes to
`Response.json()`. The first two bytes of the body are `1f 8b`.

Because this workflow had never run on GitHub, the failure had never surfaced. It would have failed
the first real Actions run in Phase 17.

`scripts/audit-dependencies.mjs` replaces it: same documented endpoint, gzip magic number sniffed
rather than assumed, and version-to-advisory matching done with `semver` because the endpoint
returns every advisory matching *any* submitted version of a package without saying which. Five
unit tests in `packages/test-fixtures/src/repository-hygiene.test.ts` pin the behaviour, including
the case that matters: an advisory covering no installed version is dropped rather than reported.

---

## Findings

### Resolved — two high advisories in `postcss@8.4.31`

| | |
|---|---|
| Package | `postcss@8.4.31`, a direct dependency of `next@16.2.11` |
| Advisories | [GHSA-6g55-p6wh-862q](https://github.com/advisories/GHSA-6g55-p6wh-862q) (`<=8.5.11`), [GHSA-r28c-9q8g-f849](https://github.com/advisories/GHSA-r28c-9q8g-f849) (`<=8.5.17`) |
| Severity | high, both |
| Impact | arbitrary file read and path traversal via an attacker-controlled `sourceMappingURL` in a CSS comment |
| Patched version | **none published** for either |
| Decision | override the tree to `postcss@8.5.23`, which is outside both ranges |
| Fix | `pnpm.overrides` in `package.json`; `pnpm-lock.yaml` now resolves one `postcss@8.5.23` and no `8.4.x` |
| Verification | `make scan-deps` exit 0; the web application builds and all 86 browser tests pass on the new version; `repository-hygiene.test.ts` asserts no `8.4.x` remains in the lockfile |
| Residual risk | none |

Exploitability was not the deciding factor — FlightRules' CSS is first-party and processed at build
time — but an override was a one-line focused change and resolving a high finding is better than
arguing it away.

### Disclosed — one moderate in `@hono/node-server@1.19.15`

| | |
|---|---|
| Package | `@hono/node-server@1.19.15`, a transitive dependency of `@modelcontextprotocol/sdk@1.29.0` |
| Advisory | [GHSA-frvp-7c67-39w9](https://github.com/advisories/GHSA-frvp-7c67-39w9) (`<2.0.5`) |
| Severity | moderate — below the `high` gate |
| Impact | path traversal in the `serve-static` middleware **on Windows**, via an encoded backslash |
| Patched version | none published in the `1.x` line |
| Decision | **accept and disclose** |
| Reasoning | FlightRules is an MCP **client**. It never constructs a Hono server, never serves static files, and never runs on Windows — the supported targets are macOS and Linux. Upgrading would mean overriding a transitive dependency of the pinned MCP SDK across a major version, which risks the one integration the product cannot function without, to remove a code path that is never loaded. |
| Verification | the dependency graph is `@modelcontextprotocol/sdk → @hono/node-server`; no FlightRules module imports either |
| Residual risk | none on the supported platforms; recorded in `docs/THREAT_MODEL.md` T28 |

---

## Git-history scan

`gitleaks@8.30.1` over all 58 commits reported **45 findings** on its first run. Every one was
inspected:

| Count | Location | What it actually is |
|---|---|---|
| 40 | `docs/evidence/phase-11/canary-gate.json` | `"ruleKey": "require-fraud-check-4dccc488"` — a FlightRules rule identifier with its content-hash suffix, matched by the generic-API-key heuristic |
| 3 | `packages/telemetry/src/logs.test.ts` | deliberately credential-shaped literals in the tests that assert credentials are redacted |
| 1 | `packages/domain/src/redaction.test.ts` | the same |
| 1 | `packages/baseline-miner/src/emit.test.ts` | `agent.idempotency.key_hash` — a salted SHA-256. Emitting the hash instead of the key is the privacy control (PRD section 17.6); the rule matched the control working |

None is a credential. `.gitleaks.toml` allowlists exactly these four locations with the reasoning
next to each entry, and `make scan-history` now exits 0 over the full history.

The allowlist exists for a specific reason, stated in the file: **45 known-benign findings make a
real one invisible.** A scan whose output is always noisy is a scan nobody reads.

---

## Workflow review

`.github/workflows/ci.yml` and `.github/workflows/release-gate.yml`:

- `permissions: contents: read` on both, at the top level;
- every action pinned to a major version tag (`actions/checkout@v5`, `pnpm/action-setup@v4`,
  `actions/setup-node@v5`, `actions/upload-artifact@v4`);
- **no long-lived secret exists.** The SigNoz API key is minted per run by
  `scripts/bootstrap-signoz.sh`; the admin password is derived from the run identifier and never
  echoed. A fork pull request needs no secret and can read none;
- artefact uploads name explicit paths. `.env` — which holds the minted key — is not among them,
  and fourteen tests in `packages/test-fixtures/src/release-gate-workflow.test.ts` assert the
  workflow's shape, including that no step is `continue-on-error` and that the canary gate's exit
  code is asserted rather than collected;
- `concurrency` with `cancel-in-progress` on both, so a superseded run cannot race a newer one.

One finding, and it is a defect this phase fixed rather than a workflow issue: the `security` job
called a command that could not succeed. See above.

## Dockerfile and deployment review

- `Dockerfile.demo` builds from the pinned Node image, copies only the workspace it needs, and runs
  the service directly. No secret is passed as a build argument and none is baked into a layer.
- `compose.app.yaml` publishes only the ports the local demo needs, and reads every credential from
  the environment at runtime.
- `casting.yaml.lock` and the generated `pours/deployment/compose.yaml` pin every image by tag;
  `make signoz-reproducibility` asserts no floating `:latest` survives, and `make signoz-verify`
  asserts each running container's tag matches the compatibility matrix.
- **One documented local-mode note**, reported by `make signoz-verify` itself: the SigNoz MCP port
  is published on the host. That is correct for local development and forbidden in a production
  deployment (PRD section 18.2). `docs/THREAT_MODEL.md` T20 records it as controlled per mode.

---

## Reproducing this

```bash
make scan-deps        # dependency advisories, gate: high
make scan-licences    # licence allowlist over the installed tree
make scan-secrets     # secretlint over the working tree
make scan-history     # gitleaks over the whole git history
make signoz-verify    # deployment surfaces, including the published-port note
```
