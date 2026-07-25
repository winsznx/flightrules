import { FlightRulesError } from "@flightrules/domain";
import type { McpFailure, McpResult } from "./outcome.js";
import { isSuccess } from "./outcome.js";

/**
 * Create-then-verify, implementing PRD section 16.5.
 *
 * A successful write response is not proof that the resource is correct. SigNoz update tools
 * replace the whole resource, field names differ between the submitted specification and the
 * stored representation, and a create can succeed while storing something other than what was
 * asked for. So every write is followed by a read-back and a field comparison, and a material
 * difference fails the operation rather than being logged and ignored.
 */

export interface FieldComparison {
  readonly field: string;
  readonly expected: unknown;
  readonly actual: unknown;
  readonly matches: boolean;
}

export type VerifiedWrite =
  | {
      readonly status: "VERIFIED";
      readonly id: string;
      readonly comparisons: readonly FieldComparison[];
      readonly resource: Readonly<Record<string, unknown>>;
    }
  | {
      readonly status: "MISMATCHED";
      readonly id: string;
      readonly comparisons: readonly FieldComparison[];
      readonly mismatchedFields: readonly string[];
      readonly resource: Readonly<Record<string, unknown>>;
    }
  | { readonly status: "NAME_COLLISION"; readonly existingId: string; readonly name: string }
  | { readonly status: "CREATE_FAILED"; readonly failure: McpFailure }
  | { readonly status: "READBACK_FAILED"; readonly id: string; readonly failure: McpFailure };

/**
 * Reads a field from a stored resource by dotted path. Paths are split on `.` and traversed
 * literally; no expression is evaluated, so a specification cannot reach outside the resource.
 */
export function readPath(resource: unknown, path: string): unknown {
  let current: unknown = resource;
  for (const segment of path.split(".")) {
    if (current === null || typeof current !== "object") return undefined;
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index)) return undefined;
      current = current[index];
      continue;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/**
 * Structural equality with stable key ordering, so two objects that differ only in key order
 * compare equal. SigNoz round-trips JSON through storage and does not preserve key order.
 */
export function deepEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
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

export interface CreateAndVerifyPlan<TCreated, TFetched> {
  /** Human-meaningful name, used for collision detection and evidence. */
  readonly name: string;
  /** Fields that must survive the round trip, as dotted paths into the stored resource. */
  readonly materialFields: Readonly<Record<string, unknown>>;
  readonly listExisting: () => Promise<McpResult<unknown>>;
  /** Finds an existing resource with the same name. Returns its id, or undefined. */
  readonly findExisting: (value: unknown) => string | undefined;
  readonly create: () => Promise<McpResult<TCreated>>;
  readonly identifierOf: (value: TCreated) => string;
  readonly fetch: (id: string) => Promise<McpResult<TFetched>>;
  readonly resourceOf: (value: TFetched) => Readonly<Record<string, unknown>>;
}

/**
 * Runs the full flow: list for a collision, create, capture the identifier, read back, compare.
 *
 * Collision detection comes first because a retried write that creates a second resource with the
 * same name is the duplicate-artifact failure PRD section 20.1 forbids.
 */
export async function createAndVerify<TCreated, TFetched>(
  plan: CreateAndVerifyPlan<TCreated, TFetched>,
): Promise<VerifiedWrite> {
  const existing = await plan.listExisting();
  if (isSuccess(existing) && existing.outcome === "SUCCESS_WITH_ROWS") {
    const collision = plan.findExisting(existing.value);
    if (collision !== undefined) {
      return { status: "NAME_COLLISION", existingId: collision, name: plan.name };
    }
  }

  const created = await plan.create();
  if (created.outcome !== "SUCCESS_WITH_ROWS") {
    return { status: "CREATE_FAILED", failure: asFailure(created) };
  }

  const id = plan.identifierOf(created.value);

  const fetched = await plan.fetch(id);
  if (fetched.outcome !== "SUCCESS_WITH_ROWS") {
    return { status: "READBACK_FAILED", id, failure: asFailure(fetched) };
  }

  const resource = plan.resourceOf(fetched.value);
  const comparisons: FieldComparison[] = Object.entries(plan.materialFields).map(
    ([field, expected]) => {
      const actual = readPath(resource, field);
      return { field, expected, actual, matches: deepEquals(expected, actual) };
    },
  );

  const mismatchedFields = comparisons.filter((c) => !c.matches).map((c) => c.field);
  if (mismatchedFields.length > 0) {
    return { status: "MISMATCHED", id, comparisons, mismatchedFields, resource };
  }
  return { status: "VERIFIED", id, comparisons, resource };
}

function asFailure(result: McpResult<unknown>): McpFailure {
  if (isSuccess(result)) {
    // A zero-row create means the server accepted the call without returning an identifier.
    return {
      tool: result.tool,
      notices: result.notices,
      durationMs: result.durationMs,
      outcome: "UNSUPPORTED_RESPONSE",
      code: "MCP_RESPONSE_INVALID",
      reason: "the write succeeded but returned no resource identifier",
    };
  }
  return result;
}

/** Converts a non-verified outcome into the typed error the artifact compiler surfaces. */
export function assertVerified(
  result: VerifiedWrite,
): asserts result is Extract<VerifiedWrite, { status: "VERIFIED" }> {
  switch (result.status) {
    case "VERIFIED":
      return;
    case "MISMATCHED":
      throw new FlightRulesError("ARTIFACT_VERIFY_FAILED", {
        message: "The created SigNoz resource did not match the intended specification.",
        details: { id: result.id, mismatchedFields: result.mismatchedFields },
      });
    case "NAME_COLLISION":
      throw new FlightRulesError("ARTIFACT_CREATE_FAILED", {
        message: `A SigNoz resource named ${result.name} already exists.`,
        details: { existingId: result.existingId, name: result.name },
      });
    case "CREATE_FAILED":
      throw new FlightRulesError("ARTIFACT_CREATE_FAILED", {
        details: { code: result.failure.code, reason: result.failure.reason },
      });
    case "READBACK_FAILED":
      throw new FlightRulesError("ARTIFACT_VERIFY_FAILED", {
        message: "The SigNoz resource was created but could not be read back for verification.",
        details: { id: result.id, code: result.failure.code, reason: result.failure.reason },
      });
  }
}
