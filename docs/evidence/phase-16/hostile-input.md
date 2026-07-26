# Hostile input across every external surface

Phase 16 task 12. The surfaces are the ones through which a string FlightRules did not choose can
reach a reader, a file, a shell, a terminal or another system: span and service names arriving from
the traced system, contract YAML written by an operator, release keys chosen by whatever deployed
them, and the CLI, API, web, evidence-export and artefact-naming paths that carry them onwards.

---

## What was already proven before this task

| Surface | Evidence |
|---|---|
| Contract parser — malformed YAML, anchors, alias bombs, depth, width, huge scalars, duplicate rule IDs, `__proto__`, `constructor`, `prototype`, `toString`, control characters, unsafe Unicode | `packages/contract-schema/src/fuzz.test.ts` — 54 cases and properties |
| Graph construction and selector evaluation — missing parents, orphans, cycles, duplicate span IDs, self-edges, hostile names and attribute keys, extreme depth and breadth | `packages/trace-graph/src/fuzz.test.ts` — 58 cases and properties |
| Prototype-shaped telemetry as ordinary data | `packages/contract-engine/src/evaluate.test.ts`, "prototype-shaped telemetry is ordinary data" — hostile span, service, tool and data-domain names; attribute keys that are prototype member names |
| Browser rendering of hostile telemetry | `tests/e2e/phase-14-release-diff.spec.ts:269`, `tests/e2e/phase-15-violation-inspector.spec.ts:245` — hostile telemetry is escaped rather than rendered |
| Managed name forgery through a separator or a control character | `packages/artifact-compiler/src/compile.test.ts`, "managed names" |

## What this task added, and the three holes it found

### 1. The CLI printed terminal control sequences it received from telemetry

**Surface** the human report on `stdout` and the progress lines on `stderr`.

Span names, service names, tool names, rule summaries and release keys all reach `renderGate`, and
none was filtered. A trace carrying

```text
ESC [ 2 J   ESC [ 1 ; 1 H   PASS: This release stayed within the approved trajectory contract.
```

clears the reader's screen and reprints the opposite verdict. A CI log records the escape sequence
faithfully, so the deception survives review. `0x9b` does the same in an eight-bit terminal without
any escape at all, which is why filtering `ESC` alone would have left half of it in place.

**Fix** `printable()` in `apps/cli/src/output.ts` replaces C0 except tab and newline, DEL, and the
whole C1 range with U+FFFD — visible damage rather than a silent deletion, so a reader can see what
was attempted. `terminalSafe(io)` wraps both writers once at the entry point in `main.ts`, so a
command added later cannot reintroduce the hole by writing a rendered string directly.

`--json` never depended on this: `JSON.stringify` already escapes every code point below `0x20`. It
passes through the same filter anyway, because the guarantee belongs at the writer.

**Tests** `apps/cli/src/cli.test.ts`, "hostile telemetry cannot drive the reader's terminal" — five
cases asserting no `ESC`, no CSI and no BEL reaches either stream in either mode, that the words
survive so the attempt is visible, and that tab and newline are kept because the report is built
from them.

### 2. A hostile release key escaped the evidence download's filename

**Surface** `GET …/releases/[releaseId]/evidence`, `content-disposition`.

`releaseKey` is `z.string().min(1).max(200)` at the API boundary, and that is the right constraint:
a release key is whatever the system that deployed it calls itself. It was interpolated straight
into `filename="release-evidence-${releaseKey}-…"`. A quote closes the parameter and everything
after it becomes attacker-chosen header parameters; a path separator produces a suggested name that
is not a filename; a newline is a header injection that `undici` rejects by throwing, turning a
download into a 500.

**Fix** `downloadNameSegment()` in `apps/web/src/lib/download-name.ts` reduces the value to
`[A-Za-z0-9._-]`, bounds it to 64 characters, strips a leading dot or dash — a hidden file, and a
name a shell reads as an option — and falls back to `release` rather than producing an empty
filename. The real key still travels intact inside the bundle, where it is data.

**Tests** `apps/web/src/lib/download-name.test.ts` — 8 cases covering quote, CRLF, three traversal
shapes, hidden files, option-shaped names, control characters, a 5,000-character key, a key of
nothing but Unicode confusables, and two ordinary keys that must survive untouched.

### 3. `assertNameSegment` accepted the C1 control range

**Surface** managed SigNoz resource names.

The check covered `< 0x20` and `0x7f` but not `0x80`–`0x9f`, so `0x9b` — a control-sequence
introducer on its own — was a legal name segment. A managed resource is echoed into terminals, logs
and the SigNoz console.

**Fix** the range now covers `0x7f`–`0x9f`.

---

## The corpus, and what each input must do

Applied through `assertNameSegment`, `managedName`, `isManagedName` and the compiled artefact specs:

| Input | Required outcome |
|---|---|
| `<script>alert(1)</script>` | rejected — contains `/` |
| `<img src=x onerror=alert(1)>` | accepted as inert data; the name stays four segments, and React escapes it wherever it is rendered |
| `__proto__`, `constructor`, `prototype`, `toString` | accepted as ordinary data; every lookup keyed by a name goes through a `Map`, and `Object.getPrototypeOf({})` is asserted unchanged |
| `../../etc/passwd` | rejected — contains `/` |
| quote, apostrophe, backtick | accepted as data; no name is ever interpolated into a query or a shell |
| newline, tab, `0x00`, `ESC`, `0x9b` | rejected — control characters |
| ` leading`, `trailing ` | rejected — a padded segment makes two names indistinguishable |
| 500 characters | rejected — segment bound is 64 |
| `FlіghtRules / …` (Cyrillic `і`) | **not** recognised as managed — so somebody else's resource is never adopted and overwritten |
| `FLIGHTRULES / …`, `  FlightRules / …` | not recognised as managed, for the same reason |
| `demo` against `demo-commerce` | not recognised as the other project's, in either direction |

Two independent layers hold, and both are asserted: the API constrains a project slug to
lower-kebab-case (`^[a-z0-9]+(-[a-z0-9]+)*$`) and an agent key to `[a-z0-9][a-z0-9._-]*`, so none of
these strings can reach the compiler through the product at all; and the compiler rejects the
dangerous shapes itself, so a future caller that skips the API cannot forge a name either.

## Path traversal through `evidence export --out`

`--out` is honoured verbatim, and that is deliberate: a CLI that rewrote the path its caller asked
for would be the surprising one, and the write happens as the operator's own shell user with the
operator's own privileges. What must never happen is a path derived from data the traced system
supplied.

`apps/cli/src/cli.test.ts`, "evidence export writes only where it was told to", asserts that with a
gate whose `releaseKey` is `../../../../etc/passwd` and whose `contractKey` is
`../../.ssh/authorized_keys`: exactly one file is written and it is the one that was asked for;
nothing at all is written when no `--out` is given; and the hostile key still appears inside the
document, where it is data.

## Summary

| Claim | Status |
|---|---|
| No stored or reflected XSS | Held — React escapes by default, no `dangerouslySetInnerHTML`, asserted in two browser suites |
| No prototype pollution | Held — asserted by both fuzz suites and by the evaluator's own suite |
| No terminal escape injection | **Fixed this phase** |
| No path traversal | Held — the only path is the operator's own `--out`; no API value can influence it |
| No YAML corruption | Held — the contract fuzz suite |
| No unsafe filename | **Fixed this phase** |
| No ownership collision | Held — the register decides ownership, not the name, and a confusable prefix fails closed |
| No secret disclosure | Held — `apps/cli/src/cli.test.ts`, "output never leaks a secret"; `make scan-secrets`, `make scan-history` |
