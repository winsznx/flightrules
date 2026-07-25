import { canonicalise, FlightRulesError } from "@flightrules/domain";
import type { DesiredArtifact } from "./compile.js";

/**
 * Comparing what SigNoz stored against what FlightRules asked for (PRD Phase 10 tasks 7, 8 and 11;
 * operating-contract rule 13).
 *
 * A successful write response is not proof. This module turns a read-back into a verdict, and the
 * verdict is what the register stores, so a mismatch is reviewable long after the job that found
 * it has gone.
 */

export interface FieldComparison {
  readonly field: string;
  readonly expected: unknown;
  readonly actual: unknown;
  readonly matches: boolean;
}

export type VerificationStatus = "verified" | "mismatched" | "invalid_response";

export interface VerificationResult {
  readonly status: VerificationStatus;
  readonly comparisons: readonly FieldComparison[];
  readonly mismatchedFields: readonly string[];
  readonly reason?: string;
}

/** Traverses own properties only, so a field path naming `constructor` reads nothing. */
export function readPath(resource: unknown, path: string): unknown {
  let current: unknown = resource;
  for (const segment of path.split(".")) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      if (segment === "length") {
        current = current.length;
        continue;
      }
      const index = Number(segment);
      if (!Number.isInteger(index)) return undefined;
      current = current[index];
      continue;
    }
    if (typeof current !== "object") return undefined;
    if (!Object.hasOwn(current, segment)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/**
 * Structural equality that ignores object key order.
 *
 * SigNoz round-trips these payloads through storage and does not preserve key order, so comparing
 * serialised forms directly would report a mismatch on every single field.
 */
export function deepEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return false;
  if (typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => deepEquals(item, b[index]));
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  if (leftKeys.length !== rightKeys.length) return false;
  if (!leftKeys.every((key, index) => key === rightKeys[index])) return false;
  return leftKeys.every((key) => deepEquals(left[key], right[key]));
}

/**
 * Rejects a response that is a single-page-app shell rather than an API resource.
 *
 * SL-012: an unmatched SigNoz path returns the SPA with HTTP 200. The MCP server is the supported
 * path and normally shields us from that, but a proxy, a misconfigured ingress or a future server
 * change could put HTML in front of the same call, and a status code would not reveal it. A
 * resource is therefore rejected on its *content*: HTML markup where an object was expected, or an
 * object with none of the fields the comparison needs.
 */
export function looksLikeHtml(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const head = value.slice(0, 512).trimStart().toLowerCase();
  return head.startsWith("<!doctype html") || head.startsWith("<html") || head.startsWith("<head");
}

function isUsableResource(resource: unknown): boolean {
  if (looksLikeHtml(resource)) return false;
  if (resource === null || typeof resource !== "object" || Array.isArray(resource)) return false;
  return Object.keys(resource as Record<string, unknown>).length > 0;
}

export function verifyResource(desired: DesiredArtifact, resource: unknown): VerificationResult {
  if (!isUsableResource(resource)) {
    return {
      status: "invalid_response",
      comparisons: [],
      mismatchedFields: [],
      reason: looksLikeHtml(resource)
        ? "the read-back returned an HTML document rather than a resource"
        : "the read-back returned no usable resource object",
    };
  }

  const comparisons = Object.entries(desired.materialFields)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([field, expected]): FieldComparison => {
      const actual = readPath(resource, field);
      return { field, expected, actual, matches: deepEquals(expected, actual) };
    });

  const mismatchedFields = comparisons.filter((c) => !c.matches).map((c) => c.field);
  return {
    status: mismatchedFields.length === 0 ? "verified" : "mismatched",
    comparisons,
    mismatchedFields,
  };
}

/**
 * Drift: the resource verified at the last sync no longer matches the specification.
 *
 * Distinct from a mismatch. A mismatch is "the write did not take"; drift is "somebody edited it
 * afterwards". Both are read the same way and both are reported, but only drift is expected to
 * happen to a resource that was correct when we left it.
 */
export function detectDrift(desired: DesiredArtifact, resource: unknown): VerificationResult {
  return verifyResource(desired, resource);
}

/**
 * Reduces a verification to what is safe to persist.
 *
 * The comparison holds whole query bodies, so writing it verbatim would put a large and
 * occasionally sensitive payload into the register. Only the field paths and a short rendering of
 * the values survive, and any string longer than the limit is truncated with its length recorded.
 */
export function redactVerification(result: VerificationResult): Record<string, unknown> {
  return canonicalise({
    status: result.status,
    ...(result.reason === undefined ? {} : { reason: result.reason }),
    mismatchedFields: [...result.mismatchedFields].sort(),
    comparisons: result.comparisons.map((comparison) => ({
      field: comparison.field,
      matches: comparison.matches,
      expected: summarise(comparison.expected),
      actual: summarise(comparison.actual),
    })),
  }) as Record<string, unknown>;
}

const MAX_SUMMARY = 200;

function summarise(value: unknown): string {
  if (value === undefined) return "<absent>";
  const rendered = typeof value === "string" ? value : (JSON.stringify(value) ?? String(value));
  if (rendered.length <= MAX_SUMMARY) return rendered;
  return `${rendered.slice(0, MAX_SUMMARY)}… (${rendered.length} chars)`;
}

/** Reduces a remote resource to a snapshot small enough to store and compare on the next sync. */
export function snapshotResource(
  desired: DesiredArtifact,
  resource: unknown,
  resourceId: string | null,
): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const field of Object.keys(desired.materialFields).sort()) {
    fields[field] = summarise(readPath(resource, field));
  }
  return canonicalise({
    resourceId,
    artifactType: desired.type,
    managedName: desired.managedName,
    specHash: desired.specHash,
    fields,
  }) as Record<string, unknown>;
}

export function assertVerified(
  desired: DesiredArtifact,
  result: VerificationResult,
): asserts result is VerificationResult & { status: "verified" } {
  if (result.status === "verified") return;
  throw new FlightRulesError("ARTIFACT_VERIFY_FAILED", {
    message: `The SigNoz resource ${desired.managedName} did not match the intended specification.`,
    details: {
      managedName: desired.managedName,
      artifactType: desired.type,
      status: result.status,
      mismatchedFields: [...result.mismatchedFields],
      ...(result.reason === undefined ? {} : { reason: result.reason }),
    },
  });
}
