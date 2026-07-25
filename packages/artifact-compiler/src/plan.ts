import type { ArtifactType, DesiredArtifact } from "./compile.js";

/**
 * The sync plan (PRD Phase 10 tasks 10 and 11).
 *
 * Deciding what to do is separated from doing it, so "a second identical sync creates none and
 * updates none" is a property of a pure function that a unit test can assert exhaustively, rather
 * than a behaviour that can only be observed by talking to SigNoz twice.
 *
 * The decision uses three inputs and nothing else: the desired specification hash, the hash the
 * register recorded at the last successful sync, and whether the register still holds a remote
 * identifier. It never consults an in-memory cache, so two workers reaching the same conclusion
 * concurrently reach it from the same durable state.
 */

export type SyncOperation =
  /** No register row, or the row lost its remote identifier. */
  | "create"
  /** The register knows the resource and the desired specification has changed. */
  | "update"
  /** Same hash, resource still present. Nothing is sent to SigNoz at all. */
  | "unchanged"
  /** The register recorded a resource that SigNoz no longer has. Policy decides create or report. */
  | "recreate"
  /** A resource of this name exists in SigNoz and FlightRules does not own it. */
  | "conflict";

export interface RegisteredArtifact {
  readonly managedName: string;
  readonly artifactType: ArtifactType;
  readonly signozResourceId: string | null;
  readonly specHash: string;
  readonly status: string;
}

export interface PlannedArtifact {
  readonly desired: DesiredArtifact;
  readonly operation: Exclude<SyncOperation, "conflict">;
  readonly existingResourceId: string | null;
  readonly previousSpecHash: string | null;
}

/** A register row FlightRules owns whose managed name is no longer in the desired set. */
export interface StaleArtifact {
  readonly managedName: string;
  readonly artifactType: ArtifactType;
  readonly signozResourceId: string | null;
}

export interface SyncPlan {
  readonly planned: readonly PlannedArtifact[];
  readonly stale: readonly StaleArtifact[];
}

export interface PlanInput {
  readonly desired: readonly DesiredArtifact[];
  readonly registered: readonly RegisteredArtifact[];
  /**
   * Managed names SigNoz still holds, from the list-before-write of PRD section 16.5. A registered
   * artefact whose name is absent here was deleted remotely.
   */
  readonly remoteNames: ReadonlySet<string>;
}

/**
 * A `Map` rather than an object, so a managed name of `__proto__` or `constructor` is an ordinary
 * key rather than a prototype write. Managed names are derived from a project slug and an agent
 * key, both of which are user-supplied.
 */
function indexByName(rows: readonly RegisteredArtifact[]): Map<string, RegisteredArtifact> {
  const index = new Map<string, RegisteredArtifact>();
  for (const row of rows) index.set(row.managedName, row);
  return index;
}

export function planSync(input: PlanInput): SyncPlan {
  const registered = indexByName(input.registered);
  const desiredNames = new Set(input.desired.map((artifact) => artifact.managedName));

  const planned = input.desired.map((desired): PlannedArtifact => {
    const row = registered.get(desired.managedName);
    if (!row || row.signozResourceId === null) {
      return { desired, operation: "create", existingResourceId: null, previousSpecHash: null };
    }
    if (!input.remoteNames.has(desired.managedName)) {
      // The register says we made it; SigNoz says it is gone. Somebody deleted it by hand.
      return {
        desired,
        operation: "recreate",
        existingResourceId: null,
        previousSpecHash: row.specHash,
      };
    }
    if (row.specHash === desired.specHash && row.status === "synced") {
      return {
        desired,
        operation: "unchanged",
        existingResourceId: row.signozResourceId,
        previousSpecHash: row.specHash,
      };
    }
    return {
      desired,
      operation: "update",
      existingResourceId: row.signozResourceId,
      previousSpecHash: row.specHash,
    };
  });

  const stale = input.registered
    .filter((row) => !desiredNames.has(row.managedName) && row.status !== "deleted")
    .map((row) => ({
      managedName: row.managedName,
      artifactType: row.artifactType,
      signozResourceId: row.signozResourceId,
    }))
    .sort((a, b) => (a.managedName < b.managedName ? -1 : a.managedName > b.managedName ? 1 : 0));

  return { planned, stale };
}

/**
 * Whether a remote resource carrying a desired managed name belongs to FlightRules.
 *
 * Ownership is the register, not the name: a name FlightRules would generate but has never
 * recorded belongs to whoever created it, and overwriting it would destroy their work. This is the
 * conflict PRD Phase 10 requires be reported rather than resolved.
 */
export function isConflict(
  desired: DesiredArtifact,
  registered: readonly RegisteredArtifact[],
  remoteNames: ReadonlySet<string>,
): boolean {
  if (!remoteNames.has(desired.managedName)) return false;
  const row = indexByName(registered).get(desired.managedName);
  return row === undefined || row.signozResourceId === null;
}

export function countByOperation(plan: SyncPlan): Readonly<Record<SyncOperation, number>> {
  const counts: Record<SyncOperation, number> = {
    create: 0,
    update: 0,
    unchanged: 0,
    recreate: 0,
    conflict: 0,
  };
  for (const entry of plan.planned) counts[entry.operation] += 1;
  return counts;
}
