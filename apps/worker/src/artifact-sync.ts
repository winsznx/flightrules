import {
  type ArtifactType,
  type CompiledArtifacts,
  compileArtifacts,
  type DesiredArtifact,
  isConflict,
  type PlannedArtifact,
  planSync,
  type RegisteredArtifact,
  redactVerification,
  type SyncPlan,
  snapshotResource,
  type VerificationResult,
  verifyResource,
} from "@flightrules/artifact-compiler";
import type {
  ArtifactOperation,
  ArtifactStatus,
  Db,
  StoredArtifact,
  UpsertArtifactInput,
} from "@flightrules/db";
import { listArtifacts, upsertArtifact } from "@flightrules/db";
import { FlightRulesError } from "@flightrules/domain";
import {
  channelDeliveryOf,
  identifierOf,
  isSuccess,
  itemsOf,
  type McpResult,
  type OperationContext,
  type SigNozOperations,
} from "@flightrules/signoz-mcp";
import type { WorkerStage } from "./runner.js";

/**
 * Turning a compiled plan into verified SigNoz resources (PRD Phase 10 tasks 6–11).
 *
 * Every write here obeys operating-contract rule 13 without exception: list, write, read back by
 * identifier, compare the fields that matter, persist the verdict, and fail on a material
 * mismatch. A successful MCP response is never treated as proof of anything.
 *
 * Nothing in this file decides *what* an artefact should be. Compilation, planning and comparison
 * are `@flightrules/artifact-compiler`; this is the part that talks to SigNoz and to the database,
 * which is exactly the part that cannot be a pure function.
 */

const CONTEXT: OperationContext = {
  searchContext:
    "FlightRules artifact compiler: synchronise the managed SigNoz views, dashboard and alerts for an active trajectory contract",
};

export interface ArtifactSyncInput {
  readonly projectId: string;
  readonly agentId: string;
  readonly contractId: string;
  readonly projectSlug: string;
  readonly agentKey: string;
  readonly contractVersion: string;
  readonly rootSpanName: string;
  readonly violationThreshold: number;
  readonly webhookUrl: string;
  /** Public SigNoz base URL, used to rewrite the container-internal `webUrl` SigNoz returns. */
  readonly signozBaseUrl: string;
  readonly attempt: number;
}

export interface ArtifactOutcome {
  readonly managedName: string;
  readonly artifactType: ArtifactType;
  readonly operation: ArtifactOperation;
  readonly status: ArtifactStatus;
  readonly resourceId: string | null;
  readonly webUrl: string | null;
  readonly specHash: string;
  readonly verification: VerificationResult | null;
  readonly reason?: string;
}

export interface ArtifactSyncResult {
  readonly outcomes: readonly ArtifactOutcome[];
  readonly planHash: string;
  readonly created: number;
  readonly updated: number;
  readonly unchanged: number;
  readonly conflicts: number;
  readonly failed: number;
  readonly stale: readonly string[];
  readonly channel: {
    readonly name: string;
    readonly reach: string;
    readonly redactedUrl: string;
    readonly deliveryTested: boolean;
    readonly deliveryVerified: boolean | undefined;
  };
}

/** Every remote resource of one type, keyed by name, from the list-before-write of PRD 16.5. */
interface RemoteIndex {
  readonly byName: ReadonlyMap<string, { readonly id: string; readonly raw: unknown }>;
}

/**
 * Where a list item's name and identifier actually live, per artefact type.
 *
 * These are **not** uniform, and guessing costs correctness rather than tidiness (SL-056). The
 * pinned v0.9.0 server returns:
 *
 * | tool | name field | identifier field |
 * |---|---|---|
 * | `signoz_list_views` | `name` | `id` |
 * | `signoz_list_notification_channels` | `name` | `id` |
 * | `signoz_list_dashboards` | `name` | **`uuid`** |
 * | `signoz_list_alert_rules` | **`alert`** | **`ruleId`** |
 *
 * A single `id` lookup silently returns nothing for a dashboard and for an alert, which makes
 * every already-created dashboard and alert look absent — so the next sync creates a second copy.
 * That is exactly the duplicate-artefact failure PRD section 20.1 forbids, and the live
 * integration test caught it by finding two managed dashboards of the same name.
 */
export const LIST_FIELDS: Readonly<Record<ArtifactType, { name: string; id: string }>> = {
  saved_view: { name: "name", id: "id" },
  notification_channel: { name: "name", id: "id" },
  dashboard: { name: "name", id: "uuid" },
  alert: { name: "alert", id: "ruleId" },
};

export function stringField(item: unknown, key: string): string | undefined {
  if (item === null || typeof item !== "object") return undefined;
  const value = (item as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function requireRows<T>(result: McpResult<T>, what: string): T | null {
  if (result.outcome === "SUCCESS_EMPTY") return null;
  if (!isSuccess(result)) {
    throw new FlightRulesError("ARTIFACT_CREATE_FAILED", {
      message: `The SigNoz MCP call for ${what} did not succeed.`,
      details: { what, outcome: result.outcome, code: result.code },
    });
  }
  return result.value;
}

/**
 * Rewrites the deep link SigNoz returns.
 *
 * SigNoz builds `webUrl` from its own container hostname (`http://signoz-signoz-0:8080/...`),
 * which no browser outside the Compose network can open. The path is kept verbatim and only the
 * origin is replaced, so a future SigNoz route change is carried through rather than reinvented.
 */
export function publicWebUrl(raw: unknown, baseUrl: string): string | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  try {
    const parsed = new URL(raw);
    const base = new URL(baseUrl);
    return `${base.origin}${parsed.pathname}${parsed.search}`;
  } catch {
    return null;
  }
}

function webUrlOf(resource: unknown, baseUrl: string): string | null {
  if (resource === null || typeof resource !== "object") return null;
  return publicWebUrl((resource as Record<string, unknown>)["webUrl"], baseUrl);
}

export class ArtifactSynchroniser {
  readonly #operations: SigNozOperations;

  constructor(operations: SigNozOperations) {
    this.#operations = operations;
  }

  async listRemote(type: ArtifactType): Promise<RemoteIndex> {
    const result = await (type === "saved_view"
      ? this.#operations.listViews("traces", CONTEXT)
      : type === "dashboard"
        ? this.#operations.listDashboards(CONTEXT)
        : type === "alert"
          ? this.#operations.listAlertRules(CONTEXT)
          : this.#operations.listNotificationChannels(CONTEXT));

    const fields = LIST_FIELDS[type];
    const byName = new Map<string, { id: string; raw: unknown }>();
    const payload = requireRows(result, `listing ${type} resources`);
    if (payload === null) return { byName };
    for (const item of itemsOf(payload)) {
      const name = stringField(item, fields.name);
      const id = stringField(item, fields.id);
      if (name !== undefined && id !== undefined) byName.set(name, { id, raw: item });
    }
    return { byName };
  }

  async create(
    desired: DesiredArtifact,
  ): Promise<{ id: string; delivery?: ReturnType<typeof channelDeliveryOf> }> {
    switch (desired.type) {
      case "saved_view": {
        const result = await this.#operations.createView(desired.spec, CONTEXT);
        const payload = requireRows(result, `creating view ${desired.managedName}`);
        if (payload === null) throw createFailed(desired, "the create returned no identifier");
        return { id: identifierOf(payload) };
      }
      case "dashboard": {
        const result = await this.#operations.createDashboard(desired.spec, CONTEXT);
        const payload = requireRows(result, `creating dashboard ${desired.managedName}`);
        if (payload === null) throw createFailed(desired, "the create returned no identifier");
        return { id: identifierOf(payload) };
      }
      case "alert": {
        const result = await this.#operations.createAlert(desired.spec, CONTEXT);
        const payload = requireRows(result, `creating alert ${desired.managedName}`);
        if (payload === null) throw createFailed(desired, "the create returned no identifier");
        return { id: identifierOf(payload) };
      }
      case "notification_channel": {
        const result = await this.#operations.createNotificationChannel(desired.spec, CONTEXT);
        const payload = requireRows(result, `creating channel ${desired.managedName}`);
        if (payload === null) throw createFailed(desired, "the create returned no identifier");
        return { id: payload.channel.data.id, delivery: channelDeliveryOf(payload) };
      }
      default:
        throw createFailed(desired, "unsupported artefact type");
    }
  }

  /**
   * Replaces a resource.
   *
   * Every update tool on the pinned server is a full replacement, and the argument shape differs
   * per tool: `{id, view}` and `{id, dashboard}` are nested, while alerts and channels are flat
   * with `id` alongside the fields. Sending a partial body would erase whatever it omitted, so the
   * complete compiled specification is always submitted — never a diff.
   */
  async update(desired: DesiredArtifact, id: string): Promise<{ id: string }> {
    switch (desired.type) {
      case "saved_view": {
        // `signoz_update_view` is unusable on the pinned server (SL-057): whatever body it is
        // given, it persists the composite query as a hex-encoded byte string, after which
        // `signoz_list_views` returns HTTP 500 for the whole tenant and every saved view becomes
        // unreadable — including views FlightRules did not create.
        //
        // Replacement is therefore delete-then-create. A saved view holds no server-side state
        // anything else references, so the only cost is a new resource identifier, which the
        // register records. The managed name is still unique at every point a caller can observe,
        // and the new resource is read back and verified exactly as a create is.
        requireRows(
          await this.#operations.deleteView(id, CONTEXT),
          `replacing view ${desired.managedName}`,
        );
        const created = await this.create(desired);
        return { id: created.id };
      }
      case "dashboard":
        requireRows(
          await this.#operations.updateDashboard(id, desired.spec, CONTEXT),
          `updating dashboard ${desired.managedName}`,
        );
        return { id };
      case "alert":
        requireRows(
          await this.#operations.updateAlert(id, desired.spec, CONTEXT),
          `updating alert ${desired.managedName}`,
        );
        return { id };
      case "notification_channel":
        requireRows(
          await this.#operations.updateNotificationChannel(id, desired.spec, CONTEXT),
          `updating channel ${desired.managedName}`,
        );
        return { id };
      default:
        throw createFailed(desired, "unsupported artefact type");
    }
  }

  /** Read-back by identifier. This is the proof, not the write response. */
  async readBack(desired: DesiredArtifact, id: string): Promise<unknown> {
    const result =
      desired.type === "saved_view"
        ? await this.#operations.getView(id, CONTEXT)
        : desired.type === "dashboard"
          ? await this.#operations.getDashboard(id, CONTEXT)
          : desired.type === "alert"
            ? await this.#operations.getAlert(id, CONTEXT)
            : await this.#operations.getNotificationChannel(id, CONTEXT);
    const payload = requireRows(result, `reading back ${desired.managedName}`);
    return payload === null ? null : payload.data;
  }
}

function createFailed(desired: DesiredArtifact, reason: string): FlightRulesError {
  return new FlightRulesError("ARTIFACT_CREATE_FAILED", {
    message: `FlightRules could not create the SigNoz resource ${desired.managedName}.`,
    details: { managedName: desired.managedName, artifactType: desired.type, reason },
  });
}

export interface SyncDependencies {
  readonly synchroniser: ArtifactSynchroniser;
  readonly now: () => Date;
  readonly progress?: (stage: WorkerStage, message: string) => Promise<void>;
}

/**
 * Runs one sync.
 *
 * Ordering matters and is fixed by compilation: the notification channel comes first, because the
 * server refuses an alert whose threshold names a channel that does not exist. Views and the
 * dashboard follow, then the alerts that reference the channel.
 */
export async function synchroniseArtifacts(
  input: ArtifactSyncInput,
  registered: readonly StoredArtifact[],
  dependencies: SyncDependencies,
): Promise<{ result: ArtifactSyncResult; writes: readonly UpsertArtifactInput[] }> {
  const compiled: CompiledArtifacts = compileArtifacts({
    projectSlug: input.projectSlug,
    agentKey: input.agentKey,
    contractVersion: input.contractVersion,
    rootSpanName: input.rootSpanName,
    violationThreshold: input.violationThreshold,
    webhookUrl: input.webhookUrl,
  });

  const remoteByType = new Map<ArtifactType, RemoteIndex>();
  for (const type of uniqueTypes(compiled.artifacts)) {
    remoteByType.set(type, await dependencies.synchroniser.listRemote(type));
  }
  const remoteNames = new Set<string>();
  for (const index of remoteByType.values()) {
    for (const name of index.byName.keys()) remoteNames.add(name);
  }

  const registeredRows: RegisteredArtifact[] = registered.map((row) => ({
    managedName: row.managedName,
    artifactType: row.artifactType as ArtifactType,
    signozResourceId: row.signozResourceId,
    specHash: row.specHash,
    status: row.status,
  }));

  const plan: SyncPlan = planSync({
    desired: compiled.artifacts,
    registered: registeredRows,
    remoteNames,
  });

  const outcomes: ArtifactOutcome[] = [];
  const writes: UpsertArtifactInput[] = [];
  let channelDelivery: { tested: boolean; delivered: boolean | undefined } = {
    tested: false,
    delivered: undefined,
  };

  for (const entry of plan.planned) {
    await dependencies.progress?.("syncing", `${entry.operation} ${entry.desired.managedName}`);
    const outcome: ArtifactOutcome = await applyOne(entry, {
      input,
      registeredRows,
      remoteNames,
      dependencies,
      onChannelDelivery: (delivery) => {
        channelDelivery = delivery;
      },
      remoteIdOf: (desired) => remoteByType.get(desired.type)?.byName.get(desired.managedName)?.id,
    });
    outcomes.push(outcome);
    writes.push(toUpsert(input, outcome, dependencies.now()));
  }

  return {
    result: {
      outcomes,
      planHash: compiled.planHash,
      created: outcomes.filter((o) => o.operation === "created").length,
      updated: outcomes.filter((o) => o.operation === "updated").length,
      unchanged: outcomes.filter((o) => o.operation === "unchanged").length,
      conflicts: outcomes.filter((o) => o.operation === "conflict").length,
      failed: outcomes.filter((o) => o.operation === "failed").length,
      stale: plan.stale.map((row) => row.managedName),
      channel: {
        name: compiled.channelName,
        reach: compiled.destination.reach,
        redactedUrl: compiled.destination.redactedUrl,
        deliveryTested: channelDelivery.tested,
        deliveryVerified: channelDelivery.delivered,
      },
    },
    writes,
  };
}

interface ApplyContext {
  readonly input: ArtifactSyncInput;
  readonly registeredRows: readonly RegisteredArtifact[];
  readonly remoteNames: ReadonlySet<string>;
  readonly dependencies: SyncDependencies;
  readonly onChannelDelivery: (delivery: {
    tested: boolean;
    delivered: boolean | undefined;
  }) => void;
  /** The identifier SigNoz currently holds for a managed name, from the list-before-write. */
  readonly remoteIdOf: (desired: DesiredArtifact) => string | undefined;
}

async function applyOne(entry: PlannedArtifact, context: ApplyContext): Promise<ArtifactOutcome> {
  const desired = entry.desired;

  // A resource of this name exists and the register has never recorded it. It is somebody else's.
  if (
    (entry.operation === "create" || entry.operation === "recreate") &&
    isConflict(desired, context.registeredRows, context.remoteNames)
  ) {
    return {
      managedName: desired.managedName,
      artifactType: desired.type,
      operation: "conflict",
      status: "conflict",
      resourceId: null,
      webUrl: null,
      specHash: desired.specHash,
      verification: null,
      reason:
        "a SigNoz resource with this managed name already exists and is not owned by FlightRules",
    };
  }

  // "Unchanged" is a claim about the *remote* resource, so it is checked by looking rather than by
  // trusting the register (task 11). Three outcomes: it still matches and nothing is written; it
  // no longer matches and is restored; or reading it fails at all — which means the identifier the
  // register holds is stale, and the artefact is created afresh below rather than reported failed.
  let staleIdentifier = false;
  // The register's hash still matches, so nothing FlightRules asked for has changed — but the
  // resource itself no longer matches, because somebody edited it. That is drift, and it must be
  // *replaced*, not created: the resource is still there under the managed name, so creating one
  // would leave two of them. This is distinct from `staleIdentifier`, where the identifier no
  // longer resolves at all.
  let drifted = false;
  if (entry.operation === "unchanged" && entry.existingResourceId !== null) {
    try {
      const resource = await context.dependencies.synchroniser.readBack(
        desired,
        entry.existingResourceId,
      );
      const verification = verifyResource(desired, resource);
      if (verification.status === "verified") {
        return {
          managedName: desired.managedName,
          artifactType: desired.type,
          operation: "unchanged",
          status: "synced",
          resourceId: entry.existingResourceId,
          webUrl: webUrlOf(resource, context.input.signozBaseUrl),
          specHash: desired.specHash,
          verification,
        };
      }
      drifted = true;
    } catch {
      staleIdentifier = true;
    }
  }

  try {
    // A stale identifier means somebody replaced the resource behind our back. FlightRules still
    // owns the name — the register has a row for it — so it adopts whatever SigNoz holds under
    // that name now and replaces it, rather than creating a second resource beside it.
    const adopted = staleIdentifier ? (context.remoteIdOf(desired) ?? null) : null;
    let resourceId = staleIdentifier ? adopted : entry.existingResourceId;
    let operation: ArtifactOperation;
    if ((entry.operation === "update" || staleIdentifier || drifted) && resourceId !== null) {
      // A view replacement returns a new identifier; a dashboard and an alert keep theirs.
      resourceId = (await context.dependencies.synchroniser.update(desired, resourceId)).id;
      operation = "updated";
    } else {
      const created = await context.dependencies.synchroniser.create(desired);
      resourceId = created.id;
      operation = "created";
      if (created.delivery) context.onChannelDelivery(created.delivery);
    }

    const resource = await context.dependencies.synchroniser.readBack(desired, resourceId);
    const verification = verifyResource(desired, resource);
    return {
      managedName: desired.managedName,
      artifactType: desired.type,
      operation: verification.status === "verified" ? operation : "failed",
      status: verification.status === "verified" ? "synced" : "failed",
      resourceId,
      webUrl: webUrlOf(resource, context.input.signozBaseUrl),
      specHash: desired.specHash,
      verification,
      ...(verification.status === "verified" ? {} : { reason: `read-back ${verification.status}` }),
    };
  } catch (error) {
    return {
      managedName: desired.managedName,
      artifactType: desired.type,
      operation: "failed",
      status: "failed",
      resourceId: entry.existingResourceId,
      webUrl: null,
      specHash: desired.specHash,
      verification: null,
      reason: error instanceof FlightRulesError ? error.code : "unexpected error",
    };
  }
}

function uniqueTypes(artifacts: readonly DesiredArtifact[]): readonly ArtifactType[] {
  const seen = new Set<ArtifactType>();
  for (const artifact of artifacts) seen.add(artifact.type);
  return [...seen];
}

function toUpsert(
  input: ArtifactSyncInput,
  outcome: ArtifactOutcome,
  at: Date,
): UpsertArtifactInput {
  const verified = outcome.status === "synced";
  return {
    projectId: input.projectId,
    agentId: outcome.artifactType === "notification_channel" ? null : input.agentId,
    artifactType: outcome.artifactType,
    managedName: outcome.managedName,
    signozResourceId: outcome.resourceId,
    signozWebUrl: outcome.webUrl,
    specHash: outcome.specHash,
    status: outcome.status,
    lastSyncedAt: outcome.operation === "conflict" ? null : at,
    lastVerifiedAt: verified ? at : null,
    // What SigNoz actually held at the moment of verification, reduced to the fields the next
    // sync compares. Never the raw MCP response: that carries whole query bodies and, for a
    // channel, the destination URL.
    remoteSnapshot: remoteSnapshotOf(outcome),
    contractId: input.contractId,
    lastOperation: outcome.operation,
    syncAttempt: input.attempt,
    verification:
      outcome.verification === null
        ? { status: outcome.status, ...(outcome.reason ? { reason: outcome.reason } : {}) }
        : redactVerification(outcome.verification),
    lastError: outcome.reason === undefined ? null : { reason: outcome.reason },
  };
}

function remoteSnapshotOf(outcome: ArtifactOutcome): Record<string, unknown> {
  if (outcome.resourceId === null || outcome.verification === null) return {};
  const observed: Record<string, unknown> = {};
  for (const comparison of outcome.verification.comparisons) {
    observed[comparison.field] = comparison.actual;
  }
  return snapshotResource(
    {
      type: outcome.artifactType,
      managedName: outcome.managedName,
      specHash: outcome.specHash,
      spec: {},
      materialFields: observed,
      agentScoped: outcome.artifactType !== "notification_channel",
    },
    observed,
    outcome.resourceId,
  );
}

export async function persistArtifactWrites(
  tx: Db,
  writes: readonly UpsertArtifactInput[],
): Promise<void> {
  for (const write of writes) {
    await upsertArtifact(tx, write);
  }
}

export async function readRegisteredArtifacts(
  sql: Db,
  projectId: string,
): Promise<readonly StoredArtifact[]> {
  return listArtifacts(sql, projectId);
}
