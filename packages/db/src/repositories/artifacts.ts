import { canonicalObject } from "../canonical.js";
import type { Db } from "../sql.js";

/**
 * The managed SigNoz artefact register (PRD section 14.14).
 *
 * Phase 09 owns the table and its reads; Phase 10 owns compilation and read-back verification. The
 * register exists here because PRD section 16.5 requires a create to be preceded by a list that
 * avoids a name collision, and that list has to survive a restart to be worth anything.
 *
 * `spec_hash` is what makes "second identical sync creates none and updates none" decidable without
 * asking SigNoz, and `remote_snapshot_json` is what makes drift detectable.
 */

export const ARTIFACT_TYPES = ["saved_view", "dashboard", "alert", "notification_channel"] as const;
export type ArtifactType = (typeof ARTIFACT_TYPES)[number];

export const ARTIFACT_STATUSES = [
  "pending",
  "synced",
  "drifted",
  "failed",
  "deleted",
  "conflict",
] as const;
export type ArtifactStatus = (typeof ARTIFACT_STATUSES)[number];

/** What the last sync actually did to the remote resource (migration 0004). */
export const ARTIFACT_OPERATIONS = [
  "created",
  "updated",
  "unchanged",
  "conflict",
  "failed",
  "stale",
] as const;
export type ArtifactOperation = (typeof ARTIFACT_OPERATIONS)[number];

interface ArtifactRow {
  readonly id: string;
  readonly project_id: string;
  readonly agent_id: string | null;
  readonly artifact_type: ArtifactType;
  readonly managed_name: string;
  readonly signoz_resource_id: string | null;
  readonly signoz_web_url: string | null;
  readonly spec_hash: string;
  readonly last_synced_at: Date | null;
  readonly last_verified_at: Date | null;
  readonly status: ArtifactStatus;
  readonly remote_snapshot_json: unknown;
  readonly contract_id: string | null;
  readonly last_operation: ArtifactOperation | null;
  readonly sync_attempt: number;
  readonly verification_json: unknown;
  readonly last_error_json: unknown;
  readonly created_at: Date;
  readonly updated_at: Date;
}

export interface StoredArtifact {
  readonly id: string;
  readonly projectId: string;
  readonly agentId: string | null;
  readonly artifactType: ArtifactType;
  readonly managedName: string;
  readonly signozResourceId: string | null;
  readonly signozWebUrl: string | null;
  readonly specHash: string;
  readonly lastSyncedAt: Date | null;
  readonly lastVerifiedAt: Date | null;
  readonly status: ArtifactStatus;
  readonly remoteSnapshot: unknown;
  readonly contractId: string | null;
  readonly lastOperation: ArtifactOperation | null;
  readonly syncAttempt: number;
  readonly verification: unknown;
  readonly lastError: unknown;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

const ARTIFACT_COLUMNS = [
  "id",
  "project_id",
  "agent_id",
  "artifact_type",
  "managed_name",
  "signoz_resource_id",
  "signoz_web_url",
  "spec_hash",
  "last_synced_at",
  "last_verified_at",
  "status",
  "remote_snapshot_json",
  "contract_id",
  "last_operation",
  "sync_attempt",
  "verification_json",
  "last_error_json",
  "created_at",
  "updated_at",
] as const;

function toStoredArtifact(row: ArtifactRow): StoredArtifact {
  return {
    id: row.id,
    projectId: row.project_id,
    agentId: row.agent_id,
    artifactType: row.artifact_type,
    managedName: row.managed_name,
    signozResourceId: row.signoz_resource_id,
    signozWebUrl: row.signoz_web_url,
    specHash: row.spec_hash,
    lastSyncedAt: row.last_synced_at,
    lastVerifiedAt: row.last_verified_at,
    status: row.status,
    remoteSnapshot: row.remote_snapshot_json,
    contractId: row.contract_id,
    lastOperation: row.last_operation,
    syncAttempt: row.sync_attempt,
    verification: row.verification_json,
    lastError: row.last_error_json,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface UpsertArtifactInput {
  readonly projectId: string;
  readonly agentId: string | null;
  readonly artifactType: ArtifactType;
  readonly managedName: string;
  readonly signozResourceId: string | null;
  readonly signozWebUrl: string | null;
  readonly specHash: string;
  readonly status: ArtifactStatus;
  readonly lastSyncedAt: Date | null;
  readonly lastVerifiedAt: Date | null;
  readonly remoteSnapshot: unknown;
  readonly contractId?: string | null;
  readonly lastOperation?: ArtifactOperation | null;
  /**
   * The attempt number this write represents. Passed in rather than incremented in SQL so a
   * retried sync that reruns the same attempt does not inflate the counter.
   */
  readonly syncAttempt?: number;
  readonly verification?: unknown;
  readonly lastError?: unknown;
}

export async function upsertArtifact(sql: Db, input: UpsertArtifactInput): Promise<StoredArtifact> {
  const rows = await sql<ArtifactRow[]>`
    insert into signoz_artifacts (
      project_id, agent_id, artifact_type, managed_name, signoz_resource_id, signoz_web_url,
      spec_hash, status, last_synced_at, last_verified_at, remote_snapshot_json,
      contract_id, last_operation, sync_attempt, verification_json, last_error_json
    ) values (
      ${input.projectId}, ${input.agentId}, ${input.artifactType}, ${input.managedName},
      ${input.signozResourceId}, ${input.signozWebUrl}, ${input.specHash}, ${input.status},
      ${input.lastSyncedAt}, ${input.lastVerifiedAt},
      ${sql.json(canonicalObject(input.remoteSnapshot))}::jsonb,
      ${input.contractId ?? null}, ${input.lastOperation ?? null}, ${input.syncAttempt ?? 0},
      ${sql.json(canonicalObject(input.verification ?? {}))}::jsonb,
      ${
        input.lastError === undefined || input.lastError === null
          ? null
          : sql.json(canonicalObject(input.lastError))
      }
    )
    on conflict (project_id, managed_name) do update set
      agent_id = excluded.agent_id,
      artifact_type = excluded.artifact_type,
      signoz_resource_id = coalesce(excluded.signoz_resource_id, signoz_artifacts.signoz_resource_id),
      signoz_web_url = coalesce(excluded.signoz_web_url, signoz_artifacts.signoz_web_url),
      spec_hash = excluded.spec_hash,
      status = excluded.status,
      last_synced_at = coalesce(excluded.last_synced_at, signoz_artifacts.last_synced_at),
      last_verified_at = coalesce(excluded.last_verified_at, signoz_artifacts.last_verified_at),
      remote_snapshot_json = excluded.remote_snapshot_json,
      contract_id = coalesce(excluded.contract_id, signoz_artifacts.contract_id),
      last_operation = excluded.last_operation,
      sync_attempt = excluded.sync_attempt,
      verification_json = excluded.verification_json,
      last_error_json = excluded.last_error_json
    returning ${sql(ARTIFACT_COLUMNS)}`;
  const row = rows[0];
  if (!row) throw new Error("signoz_artifacts returned no row");
  return toStoredArtifact(row);
}

export async function listArtifacts(
  sql: Db,
  projectId: string,
): Promise<readonly StoredArtifact[]> {
  const rows = await sql<ArtifactRow[]>`
    select ${sql(ARTIFACT_COLUMNS)} from signoz_artifacts
    where project_id = ${projectId}
    order by artifact_type asc, managed_name asc`;
  return rows.map(toStoredArtifact);
}

export async function findArtifactByName(
  sql: Db,
  projectId: string,
  managedName: string,
): Promise<StoredArtifact | null> {
  const rows = await sql<ArtifactRow[]>`
    select ${sql(ARTIFACT_COLUMNS)} from signoz_artifacts
    where project_id = ${projectId} and managed_name = ${managedName}`;
  const row = rows[0];
  return row ? toStoredArtifact(row) : null;
}
