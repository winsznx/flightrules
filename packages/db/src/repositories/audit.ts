import { canonicalObject } from "../canonical.js";
import { type Page, type PageRequest, toPage } from "../pagination.js";
import type { Db } from "../sql.js";

/**
 * Audit history (PRD section 14.16, FR-019).
 *
 * Append-only: there is no update and no delete. FR-019 lists the events that must be recorded, and
 * the closed vocabulary below is that list expanded to the specific transitions the API performs.
 * Free-text event types are refused, so "which lifecycle events are audited" stays answerable by
 * reading one array rather than by grepping call sites.
 */

export const AUDIT_EVENT_TYPES = [
  "project.created",
  "project.updated",
  "project.deleted",
  "agent.created",
  "agent.updated",
  "signoz.connection.verified",
  "baseline.requested",
  "baseline.created",
  "route_family.approved",
  "route_family.excluded",
  "route_family.rejected",
  "route_family.marked_optional",
  "contract.proposal.requested",
  "contract.created",
  "contract.updated",
  "contract.validated",
  "contract.approved",
  "contract.activated",
  "contract.superseded",
  "evaluation.requested",
  "evaluation.completed",
  "gate.decided",
  "artifact.sync.requested",
  "artifact.synced",
  "demo.reset",
  "demo.run.requested",
] as const;

export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[number];

export const ACTOR_TYPES = ["user", "system", "cli", "demo"] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];

export interface AuditEventRow {
  readonly id: string;
  readonly project_id: string | null;
  readonly actor_type: ActorType;
  readonly actor_id: string;
  readonly event_type: string;
  readonly entity_type: string;
  readonly entity_id: string;
  readonly details_json: unknown;
  readonly created_at: Date;
}

export interface AuditEvent {
  readonly id: string;
  readonly projectId: string | null;
  readonly actorType: ActorType;
  readonly actorId: string;
  readonly eventType: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly details: unknown;
  readonly createdAt: Date;
}

const AUDIT_COLUMNS = [
  "id",
  "project_id",
  "actor_type",
  "actor_id",
  "event_type",
  "entity_type",
  "entity_id",
  "details_json",
  "created_at",
] as const;

function toAuditEvent(row: AuditEventRow): AuditEvent {
  return {
    id: row.id,
    projectId: row.project_id,
    actorType: row.actor_type,
    actorId: row.actor_id,
    eventType: row.event_type,
    entityType: row.entity_type,
    entityId: row.entity_id,
    details: row.details_json,
    createdAt: row.created_at,
  };
}

export interface RecordAuditInput {
  readonly projectId: string | null;
  readonly actorType: ActorType;
  readonly actorId?: string | undefined;
  readonly eventType: AuditEventType;
  readonly entityType: string;
  readonly entityId: string;
  readonly details?: Readonly<Record<string, unknown>> | undefined;
}

/**
 * Writes one audit event.
 *
 * Called with the transaction that performed the change, never afterwards on its own connection: an
 * audit row that survives a rolled-back change would describe something that never happened.
 */
export async function recordAudit(sql: Db, input: RecordAuditInput): Promise<AuditEvent> {
  const rows = await sql<AuditEventRow[]>`
    insert into audit_events
      (project_id, actor_type, actor_id, event_type, entity_type, entity_id, details_json)
    values (
      ${input.projectId},
      ${input.actorType},
      ${input.actorId ?? "local"},
      ${input.eventType},
      ${input.entityType},
      ${input.entityId},
      ${sql.json(canonicalObject(input.details ?? {}))}::jsonb
    )
    returning ${sql(AUDIT_COLUMNS)}`;
  const row = rows[0];
  if (!row) throw new Error("audit_events returned no row");
  return toAuditEvent(row);
}

export async function listAuditEvents(
  sql: Db,
  filter: { readonly projectId?: string | undefined; readonly entityId?: string | undefined },
  request: PageRequest,
): Promise<Page<AuditEvent>> {
  const rows = await sql<AuditEventRow[]>`
    select ${sql(AUDIT_COLUMNS)} from audit_events
    where ${filter.projectId === undefined ? sql`true` : sql`project_id = ${filter.projectId}`}
      and ${filter.entityId === undefined ? sql`true` : sql`entity_id = ${filter.entityId}`}
      and ${request.after === null ? sql`true` : sql`id < ${request.after}`}
    order by id desc
    limit ${request.limit + 1}`;
  return toPage(rows.map(toAuditEvent), request);
}

export async function countAuditEvents(sql: Db, entityId: string): Promise<number> {
  const rows = await sql<{ count: string }[]>`
    select count(*)::text as count from audit_events where entity_id = ${entityId}`;
  return Number.parseInt(rows[0]?.count ?? "0", 10);
}
