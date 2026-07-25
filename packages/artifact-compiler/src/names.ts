import { FlightRulesError } from "@flightrules/domain";

/**
 * Deterministic managed resource names (PRD section 16.8, Phase 10 task 2).
 *
 * The name is the only ownership key SigNoz gives us for every artefact type — a saved view has no
 * tag field, and an alert's labels are not returned by every list shape — so it has to be both
 * stable and unambiguous. Two properties matter and are both tested:
 *
 *   * a name is a pure function of (project slug, agent key, label), so two syncs of the same
 *     contract address the same resource and a re-sync cannot create a second one; and
 *   * a name cannot be forged. The separator is ` / `, and a segment containing it is rejected
 *     rather than escaped, because escaping would let `a / b` and `a` + `b` collide.
 */

export const MANAGED_PREFIX = "FlightRules";
export const NAME_SEPARATOR = " / ";

/** PRD section 16.8's labels, plus the three FR-015 alerts the section does not enumerate. */
export const ARTIFACT_LABELS = {
  contractHealth: "Contract Health",
  violatingRuns: "Violating Runs",
  duplicateSideEffects: "Duplicate Side Effects",
  unknownRoutes: "Unknown Routes",
  releaseComparison: "Release Comparison",
  violationRateAlert: "Violation Rate Alert",
  duplicateSideEffectAlert: "Duplicate Side Effect Alert",
  releaseEvaluationErrorAlert: "Release Evaluation Error Alert",
  noEvaluationDataAlert: "No Evaluation Data Alert",
  notifications: "Notifications",
} as const;

export type ArtifactLabel = (typeof ARTIFACT_LABELS)[keyof typeof ARTIFACT_LABELS];

const MAX_SEGMENT = 64;
/** `managed_name` is `text check (length between 1 and 200)` in migration 0003. */
const MAX_NAME = 200;

/**
 * Rejects a segment that cannot appear in a managed name.
 *
 * `__proto__` and `constructor` are not special here — a name is a string, and every lookup keyed
 * by one goes through a `Map` — but a control character or a separator is, because either would
 * make two different artefacts indistinguishable by name.
 */
function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

export function assertNameSegment(segment: string, what: string): void {
  const invalid =
    segment.length === 0 ||
    segment.length > MAX_SEGMENT ||
    segment.includes("/") ||
    hasControlCharacter(segment) ||
    segment.trim() !== segment;
  if (invalid) {
    throw new FlightRulesError("VALIDATION_FAILED", {
      message: `The ${what} cannot be used in a managed SigNoz resource name.`,
      details: { what, length: segment.length },
    });
  }
}

export interface NameScope {
  readonly projectSlug: string;
  readonly agentKey: string;
}

/** `FlightRules / <project> / <agent> / <label>`. */
export function managedName(scope: NameScope, label: ArtifactLabel): string {
  assertNameSegment(scope.projectSlug, "project slug");
  assertNameSegment(scope.agentKey, "agent key");
  const name = [MANAGED_PREFIX, scope.projectSlug, scope.agentKey, label].join(NAME_SEPARATOR);
  if (name.length > MAX_NAME) {
    throw new FlightRulesError("VALIDATION_FAILED", {
      message: "The managed SigNoz resource name exceeds the stored maximum of 200 characters.",
      details: { length: name.length },
    });
  }
  return name;
}

/**
 * `FlightRules / <project> / <label>`.
 *
 * A notification channel is shared by every agent of a project, so scoping it per agent would
 * create one channel per agent for no reason and make the alert payloads disagree about which
 * channel to name.
 */
export function projectManagedName(projectSlug: string, label: ArtifactLabel): string {
  assertNameSegment(projectSlug, "project slug");
  return [MANAGED_PREFIX, projectSlug, label].join(NAME_SEPARATOR);
}

/** True when a remote resource's name is one FlightRules would generate for this project. */
export function isManagedName(name: unknown, projectSlug: string): boolean {
  if (typeof name !== "string") return false;
  return name.startsWith(`${MANAGED_PREFIX}${NAME_SEPARATOR}${projectSlug}${NAME_SEPARATOR}`);
}

/**
 * The description or tag stamped on every managed resource, so a human reading SigNoz can tell
 * what created it and what will happen if they edit it (PRD section 16.8: "Managed resources must
 * include identifying tags or descriptions where supported").
 */
export const OWNERSHIP_TAG = "flightrules-managed";

export function ownershipTags(scope: NameScope): readonly string[] {
  return [
    OWNERSHIP_TAG,
    `flightrules-project-${scope.projectSlug}`,
    `flightrules-agent-${scope.agentKey}`,
  ];
}

export function ownershipNote(scope: NameScope, contractVersion: string): string {
  return (
    `Managed by FlightRules for ${scope.projectSlug}/${scope.agentKey} from contract ` +
    `${contractVersion}. Edits are overwritten by the next contract sync.`
  );
}
