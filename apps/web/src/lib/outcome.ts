import "server-only";
import type { ApiFailure } from "./api";

/**
 * How a Server Action reports what happened (PRD Phase 13).
 *
 * An action's outcome is carried in the URL rather than in client state, and the page renders it on
 * the next server render. That is deliberate, and it is what makes the whole workflow satisfy the
 * PRD's persistence requirements without a single byte of product state in the browser:
 *
 * - a reload shows the same outcome, because the outcome is in the address;
 * - the back button works;
 * - an outcome can be linked to, which matters when a reviewer is describing what they saw;
 * - nothing has to be re-fetched from the browser to re-render it.
 *
 * The failure code is the product's own PRD section 19 code, never a stack trace and never a raw
 * message from a dependency.
 */

export const OUTCOME_PARAM = "outcome";
export const OUTCOME_CODE_PARAM = "code";
export const OUTCOME_DETAIL_PARAM = "detail";

export type OutcomeKind = "done" | "failed";

export interface Outcome {
  readonly kind: OutcomeKind;
  /** What the user asked for, in the product's own words. */
  readonly action: string;
  /** PRD section 19 error code, present only on a failure. */
  readonly code: string | null;
  /** One safe sentence. Never a dependency's raw text. */
  readonly detail: string | null;
}

export interface OutcomeInput {
  readonly kind: OutcomeKind;
  readonly action: string;
  readonly code?: string;
  readonly detail?: string;
}

/**
 * Builds the address an action redirects to.
 *
 * `target` may already carry a query string — a review action's `returnTo` is
 * `.../baselines/new?baseline=<uuid>`, for instance — so the parameters are **merged** rather than
 * appended. Concatenating a second `?` produces an address whose first parameter swallows the rest,
 * which is a bug that only shows up on the paths that carry state, and those are the paths that
 * matter most.
 */
export function outcomeUrl(
  target: string,
  outcome: OutcomeInput,
  extra?: Readonly<Record<string, string>>,
): string {
  const [path, existing] = target.split("?", 2);
  const params = new URLSearchParams(existing ?? "");

  for (const [key, value] of Object.entries(extra ?? {})) params.set(key, value);

  params.set(OUTCOME_PARAM, `${outcome.kind}:${outcome.action}`);
  params.delete(OUTCOME_CODE_PARAM);
  params.delete(OUTCOME_DETAIL_PARAM);
  if (outcome.code !== undefined) params.set(OUTCOME_CODE_PARAM, outcome.code);
  if (outcome.detail !== undefined) params.set(OUTCOME_DETAIL_PARAM, outcome.detail.slice(0, 400));

  const query = params.toString();
  return query.length === 0 ? (path ?? target) : `${path ?? target}?${query}`;
}

/** The failure form, from a typed `ApiFailure`. */
export function failureUrl(
  target: string,
  action: string,
  failure: ApiFailure,
  extra?: Readonly<Record<string, string>>,
): string {
  return outcomeUrl(
    target,
    { kind: "failed", action, code: failure.code, detail: failure.message },
    extra,
  );
}

const first = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

/** Reads an outcome back out of a route's `searchParams`. Anything malformed is simply absent. */
export function readOutcome(search: Record<string, string | string[] | undefined>): Outcome | null {
  const raw = first(search[OUTCOME_PARAM]);
  if (raw === undefined) return null;
  const separator = raw.indexOf(":");
  if (separator <= 0) return null;
  const kind = raw.slice(0, separator);
  if (kind !== "done" && kind !== "failed") return null;
  const action = raw.slice(separator + 1);
  if (action.length === 0 || action.length > 80) return null;
  return {
    kind,
    action,
    code: first(search[OUTCOME_CODE_PARAM]) ?? null,
    detail: first(search[OUTCOME_DETAIL_PARAM]) ?? null,
  };
}
