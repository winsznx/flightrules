import { canonicalObject } from "../canonical.js";
import { type Page, type PageRequest, toPage } from "../pagination.js";
import type { Db } from "../sql.js";

/**
 * Projects and SigNoz connections (PRD sections 14.1 and 14.2, FR-001).
 *
 * Every function takes the `Sql` handle as its first argument rather than closing over one, so the
 * same function runs inside a transaction or outside it without a second code path. That is what
 * makes "creating a contract and its rules is atomic" expressible without duplicating queries.
 */

export interface ProjectRow {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly description: string;
  readonly signoz_connection_id: string | null;
  readonly default_environment: string;
  readonly created_at: Date;
  readonly updated_at: Date;
}

export interface Project {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly description: string;
  readonly signozConnectionId: string | null;
  readonly defaultEnvironment: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export function toProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    signozConnectionId: row.signoz_connection_id,
    defaultEnvironment: row.default_environment,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const PROJECT_COLUMNS = [
  "id",
  "name",
  "slug",
  "description",
  "signoz_connection_id",
  "default_environment",
  "created_at",
  "updated_at",
] as const;

export interface CreateProjectInput {
  readonly name: string;
  readonly slug: string;
  readonly description?: string | undefined;
  readonly signozConnectionId?: string | null | undefined;
  readonly defaultEnvironment?: string | undefined;
}

export async function createProject(sql: Db, input: CreateProjectInput): Promise<Project> {
  const rows = await sql<ProjectRow[]>`
    insert into projects (name, slug, description, signoz_connection_id, default_environment)
    values (
      ${input.name},
      ${input.slug},
      ${input.description ?? ""},
      ${input.signozConnectionId ?? null},
      ${input.defaultEnvironment ?? "production"}
    )
    returning ${sql(PROJECT_COLUMNS)}`;
  return toProject(requireRow(rows, "projects"));
}

export async function findProject(sql: Db, id: string): Promise<Project | null> {
  const rows = await sql<ProjectRow[]>`
    select ${sql(PROJECT_COLUMNS)} from projects where id = ${id}`;
  const row = rows[0];
  return row ? toProject(row) : null;
}

export async function findProjectBySlug(sql: Db, slug: string): Promise<Project | null> {
  const rows = await sql<ProjectRow[]>`
    select ${sql(PROJECT_COLUMNS)} from projects where slug = ${slug}`;
  const row = rows[0];
  return row ? toProject(row) : null;
}

export async function listProjects(sql: Db, request: PageRequest): Promise<Page<Project>> {
  const rows = await sql<ProjectRow[]>`
    select ${sql(PROJECT_COLUMNS)} from projects
    where ${request.after === null ? sql`true` : sql`id > ${request.after}`}
    order by id asc
    limit ${request.limit + 1}`;
  return toPage(rows.map(toProject), request);
}

export interface UpdateProjectInput {
  readonly name?: string | undefined;
  readonly description?: string | undefined;
  readonly signozConnectionId?: string | null | undefined;
  readonly defaultEnvironment?: string | undefined;
}

/**
 * `slug` is deliberately absent: it is the stable public identity of a project and appears in
 * metric dimensions (PRD section 17.4), so renaming it would silently split a time series.
 */
export async function updateProject(
  sql: Db,
  id: string,
  input: UpdateProjectInput,
): Promise<Project | null> {
  const rows = await sql<ProjectRow[]>`
    update projects set
      name = coalesce(${input.name ?? null}, name),
      description = coalesce(${input.description ?? null}, description),
      signoz_connection_id = ${
        input.signozConnectionId === undefined
          ? sql`signoz_connection_id`
          : sql`${input.signozConnectionId}`
      },
      default_environment = coalesce(${input.defaultEnvironment ?? null}, default_environment)
    where id = ${id}
    returning ${sql(PROJECT_COLUMNS)}`;
  const row = rows[0];
  return row ? toProject(row) : null;
}

export async function deleteProject(sql: Db, id: string): Promise<boolean> {
  const rows = await sql<{ id: string }[]>`delete from projects where id = ${id} returning id`;
  return rows.length === 1;
}

// ---------------------------------------------------------------------------
// SigNoz connections (14.2)
// ---------------------------------------------------------------------------

export const SIGNOZ_CONNECTION_STATUSES = [
  "unverified",
  "connected",
  "degraded",
  "failed",
] as const;
export type SignozConnectionStatus = (typeof SIGNOZ_CONNECTION_STATUSES)[number];

export interface SignozConnectionRow {
  readonly id: string;
  readonly name: string;
  readonly base_url: string;
  readonly mcp_url: string;
  readonly api_key_secret_reference: string;
  readonly status: SignozConnectionStatus;
  readonly last_verified_at: Date | null;
  readonly capabilities_json: unknown;
  readonly created_at: Date;
  readonly updated_at: Date;
}

export interface SignozConnection {
  readonly id: string;
  readonly name: string;
  readonly baseUrl: string;
  readonly mcpUrl: string;
  /**
   * The **name** of the environment variable holding the key, never the key.
   * PRD section 14.2 forbids storing the value in plaintext for P0.
   */
  readonly apiKeySecretReference: string;
  readonly status: SignozConnectionStatus;
  readonly lastVerifiedAt: Date | null;
  readonly capabilities: unknown;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

const CONNECTION_COLUMNS = [
  "id",
  "name",
  "base_url",
  "mcp_url",
  "api_key_secret_reference",
  "status",
  "last_verified_at",
  "capabilities_json",
  "created_at",
  "updated_at",
] as const;

export function toSignozConnection(row: SignozConnectionRow): SignozConnection {
  return {
    id: row.id,
    name: row.name,
    baseUrl: row.base_url,
    mcpUrl: row.mcp_url,
    apiKeySecretReference: row.api_key_secret_reference,
    status: row.status,
    lastVerifiedAt: row.last_verified_at,
    capabilities: row.capabilities_json,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface UpsertSignozConnectionInput {
  readonly name: string;
  readonly baseUrl: string;
  readonly mcpUrl: string;
  readonly apiKeySecretReference: string;
  readonly status: SignozConnectionStatus;
  readonly lastVerifiedAt: Date | null;
  readonly capabilities: unknown;
}

/** Idempotent on `name`, so re-verifying a connection updates the snapshot rather than adding one. */
export async function upsertSignozConnection(
  sql: Db,
  input: UpsertSignozConnectionInput,
): Promise<SignozConnection> {
  const rows = await sql<SignozConnectionRow[]>`
    insert into signoz_connections
      (name, base_url, mcp_url, api_key_secret_reference, status, last_verified_at, capabilities_json)
    values (
      ${input.name}, ${input.baseUrl}, ${input.mcpUrl}, ${input.apiKeySecretReference},
      ${input.status}, ${input.lastVerifiedAt}, ${sql.json(canonicalObject(input.capabilities))}::jsonb
    )
    on conflict (name) do update set
      base_url = excluded.base_url,
      mcp_url = excluded.mcp_url,
      api_key_secret_reference = excluded.api_key_secret_reference,
      status = excluded.status,
      last_verified_at = excluded.last_verified_at,
      capabilities_json = excluded.capabilities_json
    returning ${sql(CONNECTION_COLUMNS)}`;
  return toSignozConnection(requireRow(rows, "signoz_connections"));
}

export async function findSignozConnectionByName(
  sql: Db,
  name: string,
): Promise<SignozConnection | null> {
  const rows = await sql<SignozConnectionRow[]>`
    select ${sql(CONNECTION_COLUMNS)} from signoz_connections where name = ${name}`;
  const row = rows[0];
  return row ? toSignozConnection(row) : null;
}

export function requireRow<T>(rows: readonly T[], table: string): T {
  const row = rows[0];
  if (!row) throw new Error(`${table} returned no row from a statement that must return one`);
  return row;
}
