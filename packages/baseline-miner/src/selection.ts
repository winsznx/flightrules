import { createHash } from "node:crypto";
import { TEXT_LIMITS } from "./safety.js";
import { type Ratio, ratioFromDecimal } from "./statistics.js";

/**
 * What the user asked to be mined.
 *
 * These are exactly PRD section 8.7's controls: release, environment, time range, minimum completed
 * runs, successful-runs-only, exclude-missing-root-span, rare-route threshold and maximum traces.
 * Nothing here has a default that hides a decision — a caller supplies the selection and
 * `resolveSelection` fills the operational knobs (batch size, span limit) that are not product
 * choices.
 */
export interface MiningSelectionInput {
  readonly projectKey: string;
  readonly agentKey: string;
  readonly releaseId: string;
  readonly environment?: string | null;
  readonly startMs: number;
  readonly endMs: number;
  readonly minimumRuns: number;
  /** Canonical span name that identifies a run root (PRD section 11.4 step 1). */
  readonly rootSpanName: string;
  readonly successfulRunsOnly?: boolean;
  readonly excludeMissingRootSpan?: boolean;
  /** Share of the baseline below which a family is marked rare. Decimal, at most six places. */
  readonly rareThreshold?: number;
  readonly maxTraces?: number;
  readonly batchSize?: number;
  readonly maxSpansPerTrace?: number;
  /** Representative traces retained per family (PRD Phase 08 task 6). */
  readonly representativesPerFamily?: number;
}

export interface MiningSelection {
  readonly projectKey: string;
  readonly agentKey: string;
  readonly releaseId: string;
  readonly environment: string | null;
  readonly startMs: number;
  readonly endMs: number;
  readonly minimumRuns: number;
  readonly rootSpanName: string;
  readonly successfulRunsOnly: boolean;
  readonly excludeMissingRootSpan: boolean;
  readonly rareThreshold: Ratio;
  readonly maxTraces: number;
  readonly batchSize: number;
  readonly maxSpansPerTrace: number;
  readonly representativesPerFamily: number;
}

const DEFAULTS = {
  successfulRunsOnly: true,
  excludeMissingRootSpan: true,
  /** PRD section 8.7 offers the control; 5% is the documented default, not a hidden constant. */
  rareThreshold: 0.05,
  maxTraces: 1_000,
  /** One page of root spans, and one batch of trace fetches. Bounded per PRD section 18.2. */
  batchSize: 200,
  maxSpansPerTrace: 10_000,
  representativesPerFamily: 3,
} as const;

/** A key that must satisfy the DSL's identifier grammar, since it reaches contract metadata. */
const KEY = /^[a-z0-9][a-z0-9._-]*$/;

function requireKey(value: string, what: string): string {
  if (value.length === 0 || value.length > TEXT_LIMITS.maxIdentifierLength || !KEY.test(value)) {
    throw new RangeError(
      `${what} must be 1 to ${TEXT_LIMITS.maxIdentifierLength} characters matching [a-z0-9][a-z0-9._-]*`,
    );
  }
  return value;
}

function requirePositiveInteger(value: number, what: string, max: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > max) {
    throw new RangeError(`${what} must be an integer in 1..${max}, received ${String(value)}`);
  }
  return value;
}

/**
 * Validates a selection and resolves every operational bound.
 *
 * Throws rather than clamping. A request for a million traces is a configuration error, and silently
 * mining a thousand of them would produce a baseline whose support ratios describe a dataset the
 * caller never asked for.
 */
export function resolveSelection(input: MiningSelectionInput): MiningSelection {
  const projectKey = requireKey(input.projectKey, "a project key");
  const agentKey = requireKey(input.agentKey, "an agent key");

  if (input.releaseId.length === 0 || input.releaseId.length > TEXT_LIMITS.maxValueLength) {
    throw new RangeError(
      "a release identifier must be non-empty and within the value length limit",
    );
  }
  if (input.rootSpanName.length === 0 || input.rootSpanName.length > TEXT_LIMITS.maxValueLength) {
    throw new RangeError("a root span name must be non-empty and within the value length limit");
  }
  if (!Number.isSafeInteger(input.startMs) || !Number.isSafeInteger(input.endMs)) {
    throw new RangeError("a mining window must be given as integer Unix milliseconds");
  }
  if (input.endMs <= input.startMs) {
    throw new RangeError("a mining window must end after it starts");
  }

  const rareThreshold = ratioFromDecimal(input.rareThreshold ?? DEFAULTS.rareThreshold);
  if (!ratioAtMostOne(rareThreshold)) {
    throw new RangeError("a rare-route threshold must be a share between 0 and 1");
  }

  return {
    projectKey,
    agentKey,
    releaseId: input.releaseId,
    environment: input.environment ?? null,
    startMs: input.startMs,
    endMs: input.endMs,
    minimumRuns: requirePositiveInteger(
      input.minimumRuns,
      "a minimum run count",
      TEXT_LIMITS.maxTraces,
    ),
    rootSpanName: input.rootSpanName,
    successfulRunsOnly: input.successfulRunsOnly ?? DEFAULTS.successfulRunsOnly,
    excludeMissingRootSpan: input.excludeMissingRootSpan ?? DEFAULTS.excludeMissingRootSpan,
    rareThreshold,
    maxTraces: requirePositiveInteger(
      input.maxTraces ?? DEFAULTS.maxTraces,
      "a maximum trace count",
      TEXT_LIMITS.maxTraces,
    ),
    batchSize: requirePositiveInteger(input.batchSize ?? DEFAULTS.batchSize, "a batch size", 1_000),
    maxSpansPerTrace: requirePositiveInteger(
      input.maxSpansPerTrace ?? DEFAULTS.maxSpansPerTrace,
      "a maximum span count",
      100_000,
    ),
    representativesPerFamily: requirePositiveInteger(
      input.representativesPerFamily ?? DEFAULTS.representativesPerFamily,
      "a representative count",
      50,
    ),
  };
}

function ratioAtMostOne(value: Ratio): boolean {
  return value.numerator <= value.denominator;
}

/**
 * A stable hash of everything that determines the dataset.
 *
 * PRD section 20.1 requires long-running jobs to be idempotent, and PRD section 18.2 requires
 * idempotency keys on them. Two requests carrying the same selection describe the same job, so this
 * is the key Phase 09 will use. The representative count is inside it because it changes the stored
 * result; the batch size is not, because it changes only how the same dataset is fetched.
 */
export function selectionHash(selection: MiningSelection): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        selection.projectKey,
        selection.agentKey,
        selection.releaseId,
        selection.environment,
        selection.startMs,
        selection.endMs,
        selection.minimumRuns,
        selection.rootSpanName,
        selection.successfulRunsOnly,
        selection.excludeMissingRootSpan,
        [selection.rareThreshold.numerator, selection.rareThreshold.denominator],
        selection.maxTraces,
        selection.maxSpansPerTrace,
        selection.representativesPerFamily,
      ]),
    )
    .digest("hex");
}

/**
 * The baseline identifier.
 *
 * Derived from the selection hash rather than generated, so mining the same window twice produces one
 * baseline identity and every family identifier derived from it is stable too. Phase 09 assigns the
 * database's own UUIDv7 primary key; this is the content identity that makes a repeated job
 * recognisable.
 */
export function baselineIdentifier(selection: MiningSelection): string {
  return `bl-${selectionHash(selection).slice(0, 32)}`;
}

/** A family identifier: stable per baseline and fingerprint, never per first-seen order. */
export function routeFamilyIdentifier(baselineId: string, fingerprint: string): string {
  return `rf-${createHash("sha256").update(`${baselineId}|${fingerprint}`).digest("hex").slice(0, 32)}`;
}

export { DEFAULTS as SELECTION_DEFAULTS };
