import { canonicalObject } from "../canonical.js";
import { type Page, type PageRequest, toPage } from "../pagination.js";
import type { Db } from "../sql.js";

/**
 * Agents and releases (PRD sections 14.3 and 14.4, FR-002).
 *
 * An agent is the unit a contract governs, so its matchers are the only description FlightRules has
 * of "which traces are this agent's". They are stored as validated JSON rather than as free text so
 * a later phase can change the matcher grammar without a migration per field.
 */

export interface AgentRow {
  readonly id: string;
  readonly project_id: string;
  readonly name: string;
  readonly agent_key: string;
  readonly workflow_name_matcher: string;
  readonly root_span_matcher_json: unknown;
  readonly service_matchers_json: unknown;
  readonly tool_operation_matcher_json: unknown;
  readonly completion_criteria_json: unknown;
  readonly release_attribute_key: string;
  readonly environment_attribute_key: string;
  readonly normaliser_config_id: string;
  readonly created_at: Date;
  readonly updated_at: Date;
}

export interface RootSpanMatcher {
  readonly name?: string | undefined;
  readonly service?: string | undefined;
}

export interface CompletionCriteria {
  readonly requireCompleteTrace?: boolean | undefined;
  readonly maxSpans?: number | undefined;
}

export interface Agent {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  readonly agentKey: string;
  readonly workflowNameMatcher: string;
  readonly rootSpanMatcher: RootSpanMatcher;
  readonly serviceMatchers: readonly string[];
  readonly toolOperationMatcher: readonly string[] | null;
  readonly completionCriteria: CompletionCriteria;
  readonly releaseAttributeKey: string;
  readonly environmentAttributeKey: string;
  readonly normaliserConfigId: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

const AGENT_COLUMNS = [
  "id",
  "project_id",
  "name",
  "agent_key",
  "workflow_name_matcher",
  "root_span_matcher_json",
  "service_matchers_json",
  "tool_operation_matcher_json",
  "completion_criteria_json",
  "release_attribute_key",
  "environment_attribute_key",
  "normaliser_config_id",
  "created_at",
  "updated_at",
] as const;

function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

export function toAgent(row: AgentRow): Agent {
  const rootMatcher = (row.root_span_matcher_json ?? {}) as RootSpanMatcher;
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    agentKey: row.agent_key,
    workflowNameMatcher: row.workflow_name_matcher,
    rootSpanMatcher: rootMatcher,
    serviceMatchers: stringArray(row.service_matchers_json),
    toolOperationMatcher:
      row.tool_operation_matcher_json === null
        ? null
        : stringArray(row.tool_operation_matcher_json),
    completionCriteria: (row.completion_criteria_json ?? {}) as CompletionCriteria,
    releaseAttributeKey: row.release_attribute_key,
    environmentAttributeKey: row.environment_attribute_key,
    normaliserConfigId: row.normaliser_config_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface CreateAgentInput {
  readonly projectId: string;
  readonly name: string;
  readonly agentKey: string;
  readonly workflowNameMatcher: string;
  readonly rootSpanMatcher?: RootSpanMatcher | undefined;
  readonly serviceMatchers?: readonly string[] | undefined;
  readonly toolOperationMatcher?: readonly string[] | null | undefined;
  readonly completionCriteria?: CompletionCriteria | undefined;
  readonly releaseAttributeKey: string;
  readonly environmentAttributeKey: string;
  readonly normaliserConfigId?: string | undefined;
}

export async function createAgent(sql: Db, input: CreateAgentInput): Promise<Agent> {
  const rows = await sql<AgentRow[]>`
    insert into agents (
      project_id, name, agent_key, workflow_name_matcher, root_span_matcher_json,
      service_matchers_json, tool_operation_matcher_json, completion_criteria_json,
      release_attribute_key, environment_attribute_key, normaliser_config_id
    ) values (
      ${input.projectId}, ${input.name}, ${input.agentKey}, ${input.workflowNameMatcher},
      ${sql.json(canonicalObject(input.rootSpanMatcher ?? {}))}::jsonb,
      ${sql.json(canonicalObject(input.serviceMatchers ?? []))}::jsonb,
      ${
        input.toolOperationMatcher === undefined || input.toolOperationMatcher === null
          ? null
          : sql.json(canonicalObject(input.toolOperationMatcher))
      },
      ${sql.json(canonicalObject(input.completionCriteria ?? {}))}::jsonb,
      ${input.releaseAttributeKey}, ${input.environmentAttributeKey},
      ${input.normaliserConfigId ?? "default"}
    )
    returning ${sql(AGENT_COLUMNS)}`;
  const row = rows[0];
  if (!row) throw new Error("agents returned no row");
  return toAgent(row);
}

export async function findAgent(sql: Db, id: string): Promise<Agent | null> {
  const rows = await sql<AgentRow[]>`
    select ${sql(AGENT_COLUMNS)} from agents where id = ${id}`;
  const row = rows[0];
  return row ? toAgent(row) : null;
}

export async function findAgentByKey(
  sql: Db,
  projectId: string,
  agentKey: string,
): Promise<Agent | null> {
  const rows = await sql<AgentRow[]>`
    select ${sql(AGENT_COLUMNS)} from agents
    where project_id = ${projectId} and agent_key = ${agentKey}`;
  const row = rows[0];
  return row ? toAgent(row) : null;
}

export async function listAgents(
  sql: Db,
  projectId: string,
  request: PageRequest,
): Promise<Page<Agent>> {
  const rows = await sql<AgentRow[]>`
    select ${sql(AGENT_COLUMNS)} from agents
    where project_id = ${projectId}
      and ${request.after === null ? sql`true` : sql`id > ${request.after}`}
    order by id asc
    limit ${request.limit + 1}`;
  return toPage(rows.map(toAgent), request);
}

export interface UpdateAgentInput {
  readonly name?: string | undefined;
  readonly workflowNameMatcher?: string | undefined;
  readonly rootSpanMatcher?: RootSpanMatcher | undefined;
  readonly serviceMatchers?: readonly string[] | undefined;
  readonly toolOperationMatcher?: readonly string[] | null | undefined;
  readonly completionCriteria?: CompletionCriteria | undefined;
  readonly releaseAttributeKey?: string | undefined;
  readonly environmentAttributeKey?: string | undefined;
}

/**
 * `agent_key` and `project_id` are immutable.
 *
 * The key is the agent's stable identity in contract metadata, in metric dimensions and in every
 * mined `selectionHash`. Changing it would orphan every baseline and silently change the idempotency
 * of every future mining job, so the column is simply not writable here.
 */
export async function updateAgent(
  sql: Db,
  id: string,
  input: UpdateAgentInput,
): Promise<Agent | null> {
  const rows = await sql<AgentRow[]>`
    update agents set
      name = coalesce(${input.name ?? null}, name),
      workflow_name_matcher = coalesce(${input.workflowNameMatcher ?? null}, workflow_name_matcher),
      root_span_matcher_json = ${
        input.rootSpanMatcher === undefined
          ? sql`root_span_matcher_json`
          : sql`${sql.json(canonicalObject(input.rootSpanMatcher))}::jsonb`
      },
      service_matchers_json = ${
        input.serviceMatchers === undefined
          ? sql`service_matchers_json`
          : sql`${sql.json(canonicalObject(input.serviceMatchers))}::jsonb`
      },
      tool_operation_matcher_json = ${
        input.toolOperationMatcher === undefined
          ? sql`tool_operation_matcher_json`
          : input.toolOperationMatcher === null
            ? sql`null`
            : sql`${sql.json(canonicalObject(input.toolOperationMatcher))}::jsonb`
      },
      completion_criteria_json = ${
        input.completionCriteria === undefined
          ? sql`completion_criteria_json`
          : sql`${sql.json(canonicalObject(input.completionCriteria))}::jsonb`
      },
      release_attribute_key = coalesce(${input.releaseAttributeKey ?? null}, release_attribute_key),
      environment_attribute_key =
        coalesce(${input.environmentAttributeKey ?? null}, environment_attribute_key)
    where id = ${id}
    returning ${sql(AGENT_COLUMNS)}`;
  const row = rows[0];
  return row ? toAgent(row) : null;
}

// ---------------------------------------------------------------------------
// Releases (14.4)
// ---------------------------------------------------------------------------

export interface ReleaseRow {
  readonly id: string;
  readonly agent_id: string;
  readonly release_key: string;
  readonly commit_sha: string | null;
  readonly image_digest: string | null;
  readonly environment: string;
  readonly first_observed_at: Date | null;
  readonly last_observed_at: Date | null;
  readonly metadata_json: unknown;
  readonly created_at: Date;
  readonly updated_at: Date;
}

export interface Release {
  readonly id: string;
  readonly agentId: string;
  readonly releaseKey: string;
  readonly commitSha: string | null;
  readonly imageDigest: string | null;
  readonly environment: string;
  readonly firstObservedAt: Date | null;
  readonly lastObservedAt: Date | null;
  readonly metadata: unknown;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

const RELEASE_COLUMNS = [
  "id",
  "agent_id",
  "release_key",
  "commit_sha",
  "image_digest",
  "environment",
  "first_observed_at",
  "last_observed_at",
  "metadata_json",
  "created_at",
  "updated_at",
] as const;

export function toRelease(row: ReleaseRow): Release {
  return {
    id: row.id,
    agentId: row.agent_id,
    releaseKey: row.release_key,
    commitSha: row.commit_sha,
    imageDigest: row.image_digest,
    environment: row.environment,
    firstObservedAt: row.first_observed_at,
    lastObservedAt: row.last_observed_at,
    metadata: row.metadata_json,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface ObserveReleaseInput {
  readonly agentId: string;
  readonly releaseKey: string;
  readonly environment: string;
  readonly observedAt: Date;
  readonly commitSha?: string | null | undefined;
  readonly imageDigest?: string | null | undefined;
  readonly metadata?: Readonly<Record<string, unknown>> | undefined;
}

/**
 * Records that a release was seen, widening its observation window.
 *
 * `least`/`greatest` rather than assignment, because traces arrive out of order: a mining run over
 * an older window must not move `first_observed_at` forward or `last_observed_at` back.
 */
export async function observeRelease(sql: Db, input: ObserveReleaseInput): Promise<Release> {
  const rows = await sql<ReleaseRow[]>`
    insert into releases (
      agent_id, release_key, environment, commit_sha, image_digest,
      first_observed_at, last_observed_at, metadata_json
    ) values (
      ${input.agentId}, ${input.releaseKey}, ${input.environment},
      ${input.commitSha ?? null}, ${input.imageDigest ?? null},
      ${input.observedAt}, ${input.observedAt},
      ${sql.json(canonicalObject(input.metadata ?? {}))}::jsonb
    )
    on conflict (agent_id, release_key, environment) do update set
      commit_sha = coalesce(excluded.commit_sha, releases.commit_sha),
      image_digest = coalesce(excluded.image_digest, releases.image_digest),
      first_observed_at = least(releases.first_observed_at, excluded.first_observed_at),
      last_observed_at = greatest(releases.last_observed_at, excluded.last_observed_at)
    returning ${sql(RELEASE_COLUMNS)}`;
  const row = rows[0];
  if (!row) throw new Error("releases returned no row");
  return toRelease(row);
}

export async function findRelease(sql: Db, id: string): Promise<Release | null> {
  const rows = await sql<ReleaseRow[]>`
    select ${sql(RELEASE_COLUMNS)} from releases where id = ${id}`;
  const row = rows[0];
  return row ? toRelease(row) : null;
}

export async function findReleaseByKey(
  sql: Db,
  agentId: string,
  releaseKey: string,
  environment: string,
): Promise<Release | null> {
  const rows = await sql<ReleaseRow[]>`
    select ${sql(RELEASE_COLUMNS)} from releases
    where agent_id = ${agentId} and release_key = ${releaseKey} and environment = ${environment}`;
  const row = rows[0];
  return row ? toRelease(row) : null;
}

export async function listReleases(
  sql: Db,
  agentId: string,
  request: PageRequest,
): Promise<Page<Release>> {
  const rows = await sql<ReleaseRow[]>`
    select ${sql(RELEASE_COLUMNS)} from releases
    where agent_id = ${agentId}
      and ${request.after === null ? sql`true` : sql`id < ${request.after}`}
    order by id desc
    limit ${request.limit + 1}`;
  return toPage(rows.map(toRelease), request);
}
