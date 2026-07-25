import { ErrorState } from "@flightrules/ui";
import type { ReactNode } from "react";
import type { ApiFailure } from "./api";
import { STATES } from "./copy";

/**
 * Shared rendering helpers.
 *
 * A failure is turned into the right state here, once, so every route reports an unreachable API,
 * a missing resource and a rejected request the same way, and none of them can accidentally render
 * an empty page that reads as "there is nothing here" when the truth is "we could not ask".
 */

export function failureState(failure: ApiFailure): ReactNode {
  if (failure.code === "NOT_FOUND") {
    return (
      <ErrorState
        title={STATES.notFoundTitle}
        detail={STATES.notFoundBody}
        code={failure.code}
        testId="not-found-state"
      />
    );
  }
  if (failure.code === "SIGNOZ_UNREACHABLE" && failure.status === null) {
    return (
      <ErrorState
        title={STATES.apiUnreachableTitle}
        detail={STATES.apiUnreachableBody}
        code={failure.code}
        testId="api-unreachable-state"
      />
    );
  }
  return (
    <ErrorState
      title="FlightRules could not load this page."
      detail={failure.message}
      code={failure.code}
    />
  );
}

/** Six decimal places is right for a gate threshold and wrong for a page. Two is the reading size. */
export function percent(value: string): string {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? `${parsed.toFixed(2)}%` : "—";
}

export function signedPercent(value: string | null): string {
  if (value === null) return "not measured";
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) return "not measured";
  return `${parsed > 0 ? "+" : ""}${parsed.toFixed(2)}%`;
}

export function instant(value: string | null): string {
  if (value === null) return "—";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "—" : parsed.toISOString().replace("T", " ").slice(0, 19);
}

export function shortHash(value: string, length = 12): string {
  return value.length <= length ? value : `${value.slice(0, length)}…`;
}
