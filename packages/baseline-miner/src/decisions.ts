import type { BaselineVersion, RouteFamily, RouteFamilyStatus } from "./model.js";
import { compareStrings } from "./safety.js";

/**
 * Route-family review (PRD Phase 08 task 8, section 8.8, FR-007).
 *
 * Pure state transitions over a mined baseline. No proposal, no contract and no rule is activated
 * here or anywhere else in this package: PRD FR-018 puts approval and activation behind a human, and
 * PRD Phase 08's test list requires that no rule is activated automatically.
 */

/** PRD section 8.8's four actions. */
export const ROUTE_FAMILY_DECISIONS = [
  "approve",
  "reject",
  "mark_optional",
  "exclude_fixture_error",
] as const;

export type RouteFamilyDecisionKind = (typeof ROUTE_FAMILY_DECISIONS)[number];

export interface RouteFamilyDecision {
  readonly fingerprint: string;
  readonly decision: RouteFamilyDecisionKind;
}

export const DECISION_ERROR_CODES = [
  "UNKNOWN_FAMILY",
  "DUPLICATE_DECISION",
  "BASELINE_NOT_REVIEWABLE",
  "NO_APPROVED_FAMILY",
] as const;

export type DecisionErrorCode = (typeof DECISION_ERROR_CODES)[number];

export interface DecisionError {
  readonly code: DecisionErrorCode;
  readonly subject: string;
  readonly message: string;
}

export type DecisionResult =
  | { readonly ok: true; readonly baseline: BaselineVersion }
  | { readonly ok: false; readonly errors: readonly DecisionError[] };

const STATUS_BY_DECISION: Readonly<Record<RouteFamilyDecisionKind, RouteFamilyStatus>> = {
  approve: "approved",
  reject: "rejected",
  mark_optional: "optional",
  exclude_fixture_error: "excluded_fixture_error",
};

/**
 * Applies review decisions to a mined baseline.
 *
 * Returns errors rather than throwing, because an unknown fingerprint or a repeated decision is an
 * expected answer to "can this review be recorded" — the API of Phase 09 has to return them as a
 * field list and the Route Family Detail screen has to show them.
 *
 * A baseline whose dataset was truncated or whose run count is below the configured minimum cannot be
 * reviewed at all. Approving a family from a dataset known to be incomplete would found a policy on
 * evidence nobody can vouch for, and the state that says so exists precisely so it cannot be skipped.
 */
export function applyRouteDecisions(
  baseline: BaselineVersion,
  decisions: readonly RouteFamilyDecision[],
): DecisionResult {
  const errors: DecisionError[] = [];

  if (baseline.status === "dataset_truncated" || baseline.status === "insufficient_runs") {
    errors.push({
      code: "BASELINE_NOT_REVIEWABLE",
      subject: baseline.id,
      message:
        baseline.status === "dataset_truncated"
          ? `The dataset stopped at the maximum of ${baseline.retrieval.maxTraces} trace(s) while more were available, so it cannot found a baseline.`
          : `${baseline.counts.eligibleRuns} eligible run(s) were found; the selection requires at least ${baseline.minimumRuns}.`,
    });
  }

  const byFingerprint = new Map(baseline.families.map((family) => [family.fingerprint, family]));
  const applied = new Map<string, RouteFamilyStatus>();

  for (const decision of decisions) {
    if (!byFingerprint.has(decision.fingerprint)) {
      errors.push({
        code: "UNKNOWN_FAMILY",
        subject: decision.fingerprint,
        message: "No route family in this baseline carries that fingerprint.",
      });
      continue;
    }
    if (applied.has(decision.fingerprint)) {
      errors.push({
        code: "DUPLICATE_DECISION",
        subject: decision.fingerprint,
        message: "This route family already has a decision in the same request.",
      });
      continue;
    }
    applied.set(decision.fingerprint, STATUS_BY_DECISION[decision.decision]);
  }

  if (errors.length > 0) {
    return {
      ok: false,
      errors: errors.sort(
        (a, b) => compareStrings(a.code, b.code) || compareStrings(a.subject, b.subject),
      ),
    };
  }

  const families: readonly RouteFamily[] = baseline.families.map((family) => {
    const status = applied.get(family.fingerprint);
    return status === undefined ? family : { ...family, status };
  });

  const anyApproved = families.some((family) => family.status === "approved");

  return {
    ok: true,
    baseline: {
      ...baseline,
      families,
      status: anyApproved ? "approved" : "pending_review",
    },
  };
}

/** Fingerprints of the families a reviewer approved, sorted. */
export function approvedFingerprints(baseline: BaselineVersion): readonly string[] {
  return baseline.families
    .filter((family) => family.status === "approved")
    .map((family) => family.fingerprint)
    .sort(compareStrings);
}
