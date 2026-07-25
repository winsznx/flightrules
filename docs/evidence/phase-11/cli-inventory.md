# FlightRules CLI inventory

Written before `apps/cli` was implemented, as PRD Phase 11 task 5 and PRD section 12.3 require.
The six command names and their order are the PRD's, verbatim, and are not renamed or simplified.

## Global

| Option | Type | Default | Meaning |
|---|---|---|---|
| `--json` | flag | off | Emit one machine-readable JSON document on stdout and nothing else. |
| `--api-url <url>` | string | `$FLIGHTRULES_API_URL`, then `http://localhost:4000` | FlightRules API base URL. `http`/`https` only. |
| `--timeout <seconds>` | integer 1–3600 | `120` | Wall-clock bound for a command that waits on a job. |
| `--quiet` | flag | off | Suppress progress lines on stderr. Never suppresses the result. |
| `--help`, `-h` | flag | — | Usage for the command, exit `0`. |
| `--version` | flag | — | The CLI version, exit `0`. |

Streams:

- **stdout** carries the result and nothing else. In `--json` mode it is exactly one JSON document
  followed by one newline, so `flightrules gate check --json | jq` is safe.
- **stderr** carries progress and diagnostics. It is never parsed.

No colour, no spinner, no cursor movement, no timestamp in the result: a script must be able to
diff two runs. `process.stdout.write` is used directly — Biome forbids `console.*` except `error`
and `warn`, and a CLI that logs through a logger cannot guarantee stream discipline.

## Environment

| Variable | Required by | Meaning |
|---|---|---|
| `FLIGHTRULES_API_URL` | every command that talks to the API | API base URL |
| `FLIGHTRULES_PROJECT` | commands taking `--project` | default project slug |
| `FLIGHTRULES_AGENT` | commands taking `--agent` | default agent key |
| `FLIGHTRULES_RELEASE` | `release evaluate`, `gate check`, `evidence export` | default release key |

No credential is read, printed or accepted. The CLI never talks to SigNoz and never holds a SigNoz
API key: PRD section 12.4 puts every SigNoz call behind the server.

## Commands

### `flightrules config verify`

| | |
|---|---|
| Arguments | none |
| Options | global only |
| Needs | the API |
| stdout | the resolved configuration and each dependency's state |
| Exit | `0` every dependency up or degraded-but-readable; `4` API or database unreachable; `5` configuration rejected |
| Idempotent | yes, read-only |
| Tests | resolved-configuration rendering, API unreachable, bad URL, JSON shape, no secret in output |
| Demo use | the first command of the recording |

### `flightrules contract validate <path>`

| | |
|---|---|
| Arguments | `<path>` — a contract YAML file |
| Options | global only |
| Needs | nothing. No network, no database |
| stdout | rule count, content hash, and every validation error with its exact path and code |
| Exit | `0` valid; `5` invalid, unreadable or not a contract |
| Idempotent | yes, pure |
| Tests | the committed contract, each rejection reason, a missing file, a directory, JSON shape |
| Demo use | shown before activation |

### `flightrules baseline capture`

| | |
|---|---|
| Options | `--project`, `--agent`, `--release`, `--environment`, `--root-span`, `--lookback <minutes>`, `--minimum-runs`, `--max-traces`, `--wait/--no-wait` |
| Needs | the API and a worker |
| stdout | the baseline job, then the baseline identifier, family count and disclosures |
| Exit | `0` captured; `3` too few completed runs; `4` API, worker or SigNoz failure; `5` bad arguments |
| Idempotent | yes — the API keys the job on the miner's selection hash, so a repeat returns the same job |
| Tests | success, insufficient runs, job failure, timeout, JSON shape |
| Demo use | `make demo-full` step 8 |

### `flightrules release evaluate`

| | |
|---|---|
| Options | `--project`, `--agent`, `--release`, `--contract <id>`, `--environment`, `--root-span`, `--lookback <minutes>`, `--max-traces`, `--wait/--no-wait` |
| Needs | the API and a worker |
| stdout | the evaluation job, then the evaluation identifier, run count and violation count |
| Exit | `0` the evaluation completed (whatever it found); `3` no runs were found; `4` failure; `5` bad arguments |
| Idempotent | yes — the API keys the evaluation on the contract, scope and window |
| Tests | pass, fail, zero runs, job failure, timeout, JSON shape |
| Demo use | run before every gate check |

`release evaluate` exits `0` for a completed evaluation that found violations. Deciding is
`gate check`'s job; conflating the two would make "the evaluation ran" and "the release is safe"
the same exit code.

### `flightrules gate check`

| | |
|---|---|
| Options | `--project`, `--agent`, `--release`, `--release-id <uuid>`, `--contract <id>`, `--max-age <seconds>`, `--summary-file <path>` |
| Needs | the API |
| stdout | the decision, its findings, its rates and its disclosures |
| Exit | `0` pass; `2` contract violation; `3` insufficient data; `4` integration or evaluation error; `5` invalid configuration |
| Idempotent | yes, read-only |
| Tests | every exit code, a restarted API, machine-readable output, the GitHub summary writer, redaction |
| Demo use | the failing-gate moment |

### `flightrules evidence export`

| | |
|---|---|
| Options | `--project`, `--agent`, `--release`, `--release-id`, `--out <path>`, `--include-violations` |
| Needs | the API |
| stdout | the evidence document, or the path written when `--out` is given |
| Exit | `0` exported; `3` nothing to export; `4` failure; `5` bad arguments |
| Idempotent | yes, read-only |
| Tests | export shape, `--out` writing, no evidence, redaction |
| Demo use | uploaded by the GitHub workflow when the gate fails |

## Exit-code table

```text
0  pass
1  reserved for an unclassified crash; never returned by a classified path
2  contract violation
3  insufficient data
4  integration or evaluation error
5  invalid configuration
```

Pinned by `EXIT_CODES` in `@flightrules/contract-engine`, asserted by
`packages/contract-engine/src/exit-codes.test.ts` for every decision and every error code, and
documented in the README and the runbook.

## JSON output

Every command in `--json` mode emits one document with these keys:

```json
{
  "command": "gate check",
  "ok": true,
  "exitCode": 0,
  "result": {},
  "error": null
}
```

`error` is the typed envelope of PRD section 15 when a command fails, and `null` otherwise. The
shape is validated against a Zod schema before it is written, so a handler cannot emit a document
the contract does not describe.
