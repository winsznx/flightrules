import type { Violation } from "./api";

/**
 * The copyable evidence summary (PRD Phase 15 task 9, PRD section 8.12).
 *
 * Assembled on the server from fields that are already safe, and from nothing else. That is the
 * whole argument: this function's inputs are the violation row and its evidence bundle, neither of
 * which carries a prompt, a tool argument, a tool result, a header or a customer field, so there is
 * no path by which one could reach the clipboard.
 *
 * Deterministic: a fixed line order, no clock read, and no formatting that depends on a locale. Two
 * reviewers pasting the same violation into the same issue produce the same text.
 *
 * Not marked `server-only`, unlike `api.ts` and `load.ts`: this module performs no I/O and holds no
 * configuration, so the marker would buy nothing and would make a pure function untestable. What
 * actually matters — that it is never bundled into a client component — is asserted by the
 * client-boundary tests in `web.test.ts`, which list it among the imports a `"use client"` module
 * may not have.
 */

export interface EvidenceSummaryInput {
  readonly violation: Violation;
  readonly evidence: {
    readonly traceId: string;
    readonly spanIds: readonly string[];
    readonly canonicalNodes: readonly number[];
    readonly labels: readonly string[];
    readonly releaseId: string | null;
    readonly contractContentHash: string;
    readonly evaluatorVersion: string;
    readonly evaluatedAt: string | null;
  } | null;
  readonly decisionHash: string | null;
  readonly signozTraceUrl: string | null;
  readonly traceQualityWarnings: readonly string[];
}

/**
 * Trims and bounds a value that came from telemetry.
 *
 * Control characters become spaces before anything else: a newline inside a canonical span name
 * would otherwise let a hostile value forge an additional `key  value` line in this summary, which a
 * reader would take as FlightRules' own statement. This is the same class of defence the miner
 * applies to the comments it writes into a contract.
 */
function safe(value: string, max = 200): string {
  let cleaned = "";
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    // C0, DEL and C1. Written as a code-point test rather than a regular expression because a
    // character class containing literal control characters is unreadable and easy to get subtly
    // wrong — and because the intent, "no character that can move the cursor", is the test itself.
    cleaned += code < 0x20 || (code >= 0x7f && code <= 0x9f) ? " " : character;
  }
  return cleaned.trim().slice(0, max);
}

export function evidenceSummary(input: EvidenceSummaryInput): string {
  const { violation, evidence } = input;

  const lines: string[] = [
    "FlightRules violation evidence",
    "",
    `violation.id           ${violation.id}`,
    `rule.id                ${safe(violation.ruleKey)}`,
    `rule.type              ${safe(violation.ruleType)}`,
    `severity               ${safe(violation.severity)}`,
    `zero_tolerance         ${violation.zeroTolerance ? "yes" : "no"}`,
    `violation.type         ${safe(violation.violationType)}`,
    "",
    `release.key            ${violation.releaseKey ?? "unknown"}`,
    `release.id             ${evidence?.releaseId ?? "unknown"}`,
    `contract.id            ${violation.contractId}`,
    `contract.version       ${safe(violation.contractVersion)}`,
    `contract.content_hash  ${evidence?.contractContentHash ?? "unknown"}`,
    `decision.hash          ${input.decisionHash ?? "not evaluated as a release"}`,
    "",
    `trace.id               ${safe(violation.traceId, 64)}`,
    `evidence.span_ids      ${(evidence?.spanIds ?? []).map((id) => safe(id, 32)).join(", ") || "none recorded"}`,
    `evidence.nodes         ${(evidence?.canonicalNodes ?? []).join(", ") || "none recorded"}`,
    `evidence.labels        ${(evidence?.labels ?? []).map((label) => safe(label, 80)).join(", ") || "none recorded"}`,
    "",
    `expected               ${safe(violation.expected, 300)}`,
    `observed               ${safe(violation.observed, 300)}`,
    "",
    `evaluator.version      ${safe(evidence?.evaluatorVersion ?? "unknown", 40)}`,
    `evaluated.at           ${evidence?.evaluatedAt ?? "unknown"}`,
    `signoz.trace           ${input.signozTraceUrl ?? "no browser-reachable link is configured"}`,
  ];

  if (input.traceQualityWarnings.length > 0) {
    lines.push(
      "",
      `trace.quality          ${input.traceQualityWarnings.map((warning) => safe(warning, 60)).join(", ")}`,
      "                       These describe what this trace could not show. They are context, not",
      "                       violations, and none of them changes the finding above.",
    );
  }

  return `${lines.join("\n")}\n`;
}
