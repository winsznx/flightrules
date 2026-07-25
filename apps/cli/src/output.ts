import { type FlightRulesError, redact } from "@flightrules/domain";
import { z } from "zod";
import type { CommandName } from "./args.js";
import type { Gate } from "./client.js";

/**
 * Output rendering (PRD Phase 11 task 6, PRD section 12.3: "print machine-readable and
 * human-readable results").
 *
 * Two streams, two audiences, one rule each. `stdout` carries the result and only the result, so a
 * pipeline can consume it; in `--json` mode it is exactly one document and one newline. `stderr`
 * carries progress, so redirecting it away never changes what a script reads.
 *
 * Nothing here is decorative. No colour, no spinner, no elapsed-time counter in the result: two
 * runs over the same evidence must produce diffable output, and a terminal escape sequence in a CI
 * log is noise at best.
 *
 * Every document passes through the domain redactor before it is written. That is belt and braces —
 * the CLI never holds a credential — but the writer is the last place output can be inspected, and
 * a redaction test asserts it here rather than trusting every call site.
 */

export interface Io {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly fetch: typeof globalThis.fetch;
  readonly readFile: (path: string) => Promise<string>;
  readonly writeFile: (path: string, contents: string) => Promise<void>;
  readonly appendFile: (path: string, contents: string) => Promise<void>;
  readonly now: () => Date;
  readonly sleep: (ms: number) => Promise<void>;
}

/** The `--json` envelope. Validated before writing, so a handler cannot emit an undeclared shape. */
export const JsonEnvelope = z.object({
  command: z.string(),
  ok: z.boolean(),
  exitCode: z.number().int().min(0).max(5),
  result: z.unknown(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
      details: z.record(z.string(), z.unknown()),
    })
    .nullable(),
});

export type JsonEnvelopeValue = z.infer<typeof JsonEnvelope>;

export function writeJson(
  io: Io,
  command: CommandName,
  exitCode: number,
  result: unknown,
  error: FlightRulesError | null,
): void {
  const envelope: JsonEnvelopeValue = {
    command,
    ok: exitCode === 0,
    exitCode,
    result: redact(result ?? null),
    error:
      error === null
        ? null
        : {
            code: error.code,
            message: error.message,
            details: redact(error.details) as Record<string, unknown>,
          },
  };
  const validated = JsonEnvelope.safeParse(envelope);
  if (!validated.success) {
    // Emitting an undeclared shape would break every consumer silently. Failing loudly on stderr
    // and returning nothing on stdout is the only honest option.
    io.stderr("flightrules: internal error — the JSON result did not match its own schema\n");
    return;
  }
  io.stdout(`${JSON.stringify(validated.data, null, 2)}\n`);
}

export function progress(io: Io, quiet: boolean, message: string): void {
  if (!quiet) io.stderr(`${message}\n`);
}

/**
 * A fixed-width two-column line. Deterministic, so two runs diff cleanly.
 *
 * A label longer than the column still gets a separating space; `padEnd` alone would run a long
 * rule identifier straight into its summary.
 */
export function field(label: string, value: string): string {
  return `  ${label.padEnd(28)}${label.length >= 28 ? " " : ""}${value}\n`;
}

export function heading(text: string): string {
  return `\n${text}\n${"-".repeat(text.length)}\n`;
}

/* -------------------------------------------------------------------------- */
/* Gate rendering                                                             */
/* -------------------------------------------------------------------------- */

const DECISION_COPY: Readonly<Record<Gate["decision"], string>> = {
  pass: "PASS: This release stayed within the approved trajectory contract.",
  fail: "FAIL: This release exceeded one or more trajectory thresholds.",
  insufficient_data:
    "INSUFFICIENT DATA: More completed runs are required before a release decision can be made.",
  error: "ERROR: FlightRules could not complete the evaluation. No release decision was produced.",
};

/**
 * The human report.
 *
 * The four decision sentences are PRD section 8.11's copy verbatim, so the CLI, the Release Diff
 * page and the GitHub summary say the same thing about the same decision.
 */
export function renderGate(gate: Gate): string {
  let out = "";
  out += `${DECISION_COPY[gate.decision]}\n`;
  out += heading("Release");
  out += field("release", gate.releaseKey);
  out += field("environment", gate.environment);
  out += field("contract", `${gate.contractKey} ${gate.contractVersion} (${gate.contractState})`);
  out += field("contract hash", gate.contractContentHash);
  out += field("evaluation", gate.evaluationId);
  out += field("evaluator", gate.evaluatorVersion);
  out += field("baseline release", gate.baselineReleaseKey ?? "none");
  out += field("decision hash", gate.decisionHash);

  out += heading("Runs");
  out += field("evaluated", String(gate.counts.evaluatedRuns));
  out += field("passed", String(gate.counts.passedRuns));
  out += field("failed", String(gate.counts.failedRuns));
  out += field("errored", String(gate.counts.erroredRuns));
  out += field("insufficient", String(gate.counts.insufficientRuns));
  out += field("minimum required", String(gate.gate.minCompletedRuns));

  out += heading("Rates");
  out += field(
    "violation",
    `${gate.rates.violation.percent}%  (limit ${gate.gate.maxViolationPercent}%)`,
  );
  out += field(
    "unknown route",
    `${gate.rates.unknownRoute.percent}%  (limit ${gate.gate.maxUnknownRoutePercent}%)`,
  );
  out += field("duplicate side effect", `${gate.rates.duplicateSideEffect.percent}%`);
  out += field("missing prerequisite", `${gate.rates.missingPrerequisite.percent}%`);

  out += heading("Change from baseline");
  for (const change of [gate.changes.latency, gate.changes.tokens, gate.changes.retries]) {
    out += field(
      change.metric,
      change.measured
        ? `${change.changePercent}%  (${String(change.baseline)} -> ${String(change.candidate)})`
        : "not measured",
    );
  }

  out += heading("Violations");
  out += field("total", String(gate.counts.violations));
  out += field("critical", String(gate.counts.criticalViolations));
  out += field("zero tolerance", String(gate.counts.zeroToleranceViolations));
  out += field(
    "by severity",
    `critical ${gate.counts.severities.critical}, high ${gate.counts.severities.high}, medium ${gate.counts.severities.medium}, low ${gate.counts.severities.low}`,
  );

  if (gate.releaseRules.length > 0) {
    out += heading("Release-scoped rules");
    for (const rule of gate.releaseRules) {
      out += field(`${rule.ruleId} [${rule.outcome}]`, rule.summary);
    }
  }

  if (gate.findings.length > 0) {
    out += heading("Findings");
    for (const finding of gate.findings) {
      out += `  ${finding.code} (${finding.implies})\n`;
      out += `    ${finding.summary}\n`;
      out += `    expected ${finding.expected}; observed ${finding.observed}\n`;
    }
  }

  if (gate.disclosures.length > 0) {
    out += heading("Disclosures");
    for (const disclosure of gate.disclosures) {
      out += `  ${disclosure.code}\n    ${disclosure.summary}\n`;
    }
  }

  if (gate.evidence.representativeFailingTraceIds.length > 0) {
    out += heading("Evidence");
    out += field("failing traces", gate.evidence.representativeFailingTraceIds.join(", "));
    if (gate.evidence.zeroToleranceRuleIds.length > 0) {
      out += field("zero-tolerance rules", gate.evidence.zeroToleranceRuleIds.join(", "));
    }
    if (gate.evidence.violatedRuleIds.length > 0) {
      out += field("violated rules", gate.evidence.violatedRuleIds.join(", "));
    }
  }

  return out;
}

/**
 * The GitHub job summary (PRD Phase 11 task 10).
 *
 * Markdown, built from the same decision document the CLI printed. Nothing is read from the
 * environment except the file to append to, so there is no path by which a secret can reach it; a
 * redaction test asserts that directly.
 */
export function renderGateSummary(gate: Gate): string {
  const icon =
    gate.decision === "pass"
      ? "PASS"
      : gate.decision === "fail"
        ? "FAIL"
        : gate.decision.toUpperCase();
  let out = `## FlightRules release gate — ${icon}\n\n`;
  out += `${DECISION_COPY[gate.decision]}\n\n`;
  out += `| Field | Value |\n| --- | --- |\n`;
  out += `| Release | \`${gate.releaseKey}\` |\n`;
  out += `| Environment | \`${gate.environment}\` |\n`;
  out += `| Contract | \`${gate.contractKey}\` ${gate.contractVersion} |\n`;
  out += `| Evaluated runs | ${gate.counts.evaluatedRuns} (minimum ${gate.gate.minCompletedRuns}) |\n`;
  out += `| Failed runs | ${gate.counts.failedRuns} |\n`;
  out += `| Violation rate | ${gate.rates.violation.percent}% (limit ${gate.gate.maxViolationPercent}%) |\n`;
  out += `| Unknown route rate | ${gate.rates.unknownRoute.percent}% (limit ${gate.gate.maxUnknownRoutePercent}%) |\n`;
  out += `| Zero-tolerance violations | ${gate.counts.zeroToleranceViolations} |\n`;
  out += `| Decision hash | \`${gate.decisionHash}\` |\n`;

  if (gate.findings.length > 0) {
    out += `\n### Findings\n\n`;
    for (const finding of gate.findings) {
      out += `- **${finding.code}** (${finding.implies}) — ${finding.summary}\n`;
    }
  }

  if (gate.disclosures.length > 0) {
    out += `\n### Disclosures\n\n`;
    for (const disclosure of gate.disclosures) {
      out += `- **${disclosure.code}** — ${disclosure.summary}\n`;
    }
  }

  if (gate.evidence.representativeFailingTraceIds.length > 0) {
    out += `\n### Representative failing traces\n\n`;
    for (const traceId of gate.evidence.representativeFailingTraceIds) {
      out += `- \`${traceId}\`\n`;
    }
  }

  return out;
}

export const USAGE = `flightrules — deterministic trajectory release gates

Usage:
  flightrules <command> [options]

Commands:
  config verify                Verify the CLI configuration and the API's dependencies
  contract validate <path>     Validate a trajectory contract document
  baseline capture             Capture a known-good baseline from SigNoz traces
  release evaluate             Evaluate a release against its active contract
  gate check                   Read the release-gate decision and exit with its code
  evidence export              Export the evidence bundle for a release

Global options:
  --json                       Emit one machine-readable JSON document on stdout
  --api-url <url>              FlightRules API base URL (env FLIGHTRULES_API_URL)
  --timeout <seconds>          Bound for a command that waits on a job (default 120)
  --quiet                      Suppress progress lines on stderr
  --help, -h                   Show this help
  --version                    Show the CLI version

Exit codes:
  0  pass
  2  contract violation
  3  insufficient data
  4  integration or evaluation error
  5  invalid configuration
`;
