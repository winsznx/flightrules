# Security policy

## Reporting a vulnerability

Open a private security advisory on the repository, or email the maintainer listed on the GitHub
profile. Please do not open a public issue for a vulnerability.

Include what you did, what you expected, what happened, and — if you have one — the smallest input
that reproduces it. A trace, a contract document or a CLI invocation is more useful than a
description.

## What this project is, and what that means for its threat model

FlightRules P0 is a **single-tenant, locally deployed** product (PRD section 6.1). It has no
authentication and no multi-tenant isolation, by design and by disclosure — see `T08` in
[docs/THREAT_MODEL.md](docs/THREAT_MODEL.md). Anyone who can reach the API can read and change
everything in it. Deploy it on a trusted network, or in front of your own authenticating proxy.

The public demo deployment is the same product placed on the internet so that it can be judged. Its
data is disposable and its reset endpoint is deliberately open (`T29`).

## Threat model

[docs/THREAT_MODEL.md](docs/THREAT_MODEL.md) enumerates 33 threats, each with an asset, an attack
path, the control, the residual risk, and the test or runtime artefact that verifies it. Three are
accepted and disclosed rather than controlled; every other is controlled and cites its verification.

## What is scanned, and how

| Gate | Command | What it checks |
|---|---|---|
| Secrets in the tree | `make scan-secrets` | secretlint over every file, honouring `.gitignore` |
| Secrets in history | `make scan-history` | gitleaks over the whole git history |
| Dependency advisories | `make scan-deps` | every installed package against the npm advisory database, `semver`-matched |
| Dependency licences | `make scan-licences` | every installed package against an allowlist of permissive licences |
| Design tokens | `make scan-design` | no colour, size or font outside `design.md` |

All five run in CI. `make scan-deps` is a first-party script rather than `pnpm audit`, because
`pnpm@10.33.0` cannot parse the advisory endpoint's response — see **SL-064** in
[docs/research/source-lock.md](docs/research/source-lock.md).

## Known accepted risks

| Risk | Why it is accepted |
|---|---|
| No authentication (`T08`) | P0 is scoped to local single-tenant use. P1 adds it |
| Open demo reset (`T29`) | The public demo exists to be reset by whoever is judging it |
| `@hono/node-server` moderate advisory | Path traversal in `serve-static` **on Windows** via an encoded backslash, with no patched version published. FlightRules runs on Linux and macOS containers and does not serve static files through it |

## Secrets

The SigNoz API key is the only credential FlightRules holds. It is:

- minted by `scripts/bootstrap-signoz.sh` into `.env` with mode 600, which is git-ignored;
- stored in the database **by variable name only**, never by value (PRD section 14.2);
- registered with the domain redactor at startup, so an interpolated error message containing it is
  redacted before it reaches a log, an evidence file or a test snapshot;
- never sent to the browser — the web application talks to the API, and the API talks to SigNoz.

In CI it is minted per run rather than supplied as a repository secret, so there is no long-lived
credential to leak.
