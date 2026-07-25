import { type ErrorCode, isErrorCode } from "@flightrules/domain";
import type { ReleaseDecision } from "./release.js";

/**
 * The release-gate exit-code contract (PRD FR-012).
 *
 * The table is fixed by the PRD, not chosen here, and it lives in the engine rather than in the CLI
 * so the API, the CLI, the GitHub workflow and the tests all derive the same number from the same
 * decision. A gate that exits `0` for anything but a proven pass is the single failure mode PRD
 * section 20.1 forbids, so the mapping is total and every branch is asserted.
 *
 * `1` is deliberately absent from the mapping. It is what Node returns for an uncaught exception,
 * so reserving it keeps "the process crashed before classifying anything" distinguishable from
 * "FlightRules decided something".
 */

export const EXIT_CODES = {
  pass: 0,
  /** Reserved for an unclassified crash. Never returned by a classified path. */
  unexpected: 1,
  contractViolation: 2,
  insufficientData: 3,
  integrationError: 4,
  invalidConfiguration: 5,
} as const;

export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];

/** Every release decision maps to exactly one exit code. Total by construction. */
export function exitCodeForDecision(decision: ReleaseDecision): ExitCode {
  switch (decision) {
    case "pass":
      return EXIT_CODES.pass;
    case "fail":
      return EXIT_CODES.contractViolation;
    case "insufficient_data":
      return EXIT_CODES.insufficientData;
    case "error":
      return EXIT_CODES.integrationError;
  }
}

/**
 * Error codes that mean the operator's configuration or input is wrong rather than a dependency
 * being unavailable. These are the only ones that exit `5`.
 */
const CONFIGURATION_ERRORS: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  "CONFIG_INVALID",
  "CONTRACT_INVALID",
  "CONTRACT_CONFLICT",
  "VALIDATION_FAILED",
  "NOT_FOUND",
  "STATE_TRANSITION_INVALID",
  "DEMO_DISABLED",
]);

/** Error codes that mean the evidence is incomplete rather than wrong. These exit `3`. */
const INSUFFICIENT_DATA_ERRORS: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  "RELEASE_INSUFFICIENT_DATA",
  "BASELINE_INSUFFICIENT_RUNS",
]);

/**
 * Maps a typed FlightRules error to an exit code.
 *
 * Anything unrecognised is `4`, an integration or evaluation error — never `0`. An unknown failure
 * is a failure.
 */
export function exitCodeForError(code: unknown): ExitCode {
  if (!isErrorCode(code)) return EXIT_CODES.integrationError;
  if (CONFIGURATION_ERRORS.has(code)) return EXIT_CODES.invalidConfiguration;
  if (INSUFFICIENT_DATA_ERRORS.has(code)) return EXIT_CODES.insufficientData;
  return EXIT_CODES.integrationError;
}

/** Operator-facing one-liners for the documented codes, used by `--help` and the runbook table. */
export const EXIT_CODE_DESCRIPTIONS: Readonly<Record<ExitCode, string>> = {
  0: "pass — the release stayed within the trajectory contract",
  1: "unexpected — the process failed before it could classify the outcome",
  2: "contract violation — the release exceeded one or more trajectory thresholds",
  3: "insufficient data — more completed runs or more complete evidence are required",
  4: "integration or evaluation error — FlightRules could not complete the evaluation",
  5: "invalid configuration — the configuration, contract or request was rejected",
};
