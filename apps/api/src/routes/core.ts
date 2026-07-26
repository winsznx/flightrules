import {
  checkSchema,
  createAgent,
  createProject,
  deleteProject,
  findAgent,
  findJob,
  findProject,
  findProjectBySlug,
  findSignozConnectionByName,
  jobQueueDepth,
  listAgents,
  listArtifacts,
  listProjects,
  recordAudit,
  toPageRequest,
  updateAgent,
  updateProject,
  upsertSignozConnection,
} from "@flightrules/db";
import { FlightRulesError } from "@flightrules/domain";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { notFound, requireUuid } from "../http.js";
import type { RouteRegistry } from "../registry.js";

/**
 * Health, SigNoz setup, projects, agents and jobs (PRD sections 15.1 to 15.4 and 15.10, FR-001,
 * FR-002).
 */

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const AGENT_KEY = /^[a-z0-9][a-z0-9._-]{0,63}$/;

const PageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().min(1).max(200).optional(),
});

const IsoDate = z.string();

const ProjectResponse = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  description: z.string(),
  signozConnectionId: z.string().nullable(),
  defaultEnvironment: z.string(),
  createdAt: IsoDate,
  updatedAt: IsoDate,
});

const AgentResponse = z.object({
  id: z.string(),
  projectId: z.string(),
  name: z.string(),
  agentKey: z.string(),
  workflowNameMatcher: z.string(),
  rootSpanMatcher: z.record(z.string(), z.unknown()),
  serviceMatchers: z.array(z.string()),
  toolOperationMatcher: z.array(z.string()).nullable(),
  completionCriteria: z.record(z.string(), z.unknown()),
  releaseAttributeKey: z.string(),
  environmentAttributeKey: z.string(),
  normaliserConfigId: z.string(),
  createdAt: IsoDate,
  updatedAt: IsoDate,
});

const JobResponse = z.object({
  id: z.string(),
  jobType: z.string(),
  entityType: z.string(),
  entityId: z.string().nullable(),
  status: z.string(),
  attempt: z.number(),
  maxAttempts: z.number(),
  idempotencyKey: z.string(),
  progressStage: z.string().nullable(),
  progressIndex: z.number(),
  result: z.unknown(),
  error: z.object({ code: z.string(), message: z.string(), retryable: z.boolean() }).nullable(),
  startedAt: IsoDate.nullable(),
  completedAt: IsoDate.nullable(),
  createdAt: IsoDate,
});

function page<T extends z.ZodType>(item: T) {
  return z.object({ items: z.array(item), nextCursor: z.string().nullable() });
}

const iso = (value: Date | null): string | null => (value === null ? null : value.toISOString());

export function projectDto(project: {
  id: string;
  name: string;
  slug: string;
  description: string;
  signozConnectionId: string | null;
  defaultEnvironment: string;
  createdAt: Date;
  updatedAt: Date;
}): z.infer<typeof ProjectResponse> {
  return {
    id: project.id,
    name: project.name,
    slug: project.slug,
    description: project.description,
    signozConnectionId: project.signozConnectionId,
    defaultEnvironment: project.defaultEnvironment,
    createdAt: project.createdAt.toISOString(),
    updatedAt: project.updatedAt.toISOString(),
  };
}

export function jobDto(job: {
  id: string;
  jobType: string;
  entityType: string;
  entityId: string | null;
  status: string;
  attempt: number;
  maxAttempts: number;
  idempotencyKey: string;
  progressStage: string | null;
  progressIndex: number;
  result: unknown;
  failure: { code: string; message: string; retryable: boolean } | null;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
}): z.infer<typeof JobResponse> {
  return {
    id: job.id,
    jobType: job.jobType,
    entityType: job.entityType,
    entityId: job.entityId,
    status: job.status,
    attempt: job.attempt,
    maxAttempts: job.maxAttempts,
    idempotencyKey: job.idempotencyKey,
    progressStage: job.progressStage,
    progressIndex: job.progressIndex,
    result: job.result ?? null,
    error: job.failure
      ? { code: job.failure.code, message: job.failure.message, retryable: job.failure.retryable }
      : null,
    startedAt: iso(job.startedAt),
    completedAt: iso(job.completedAt),
    createdAt: job.createdAt.toISOString(),
  };
}

export function registerCoreRoutes(
  server: FastifyInstance,
  registry: RouteRegistry,
  context: AppContext,
): void {
  const { sql, config } = context;

  // -------------------------------------------------------------------------
  // 15.1 Health
  // -------------------------------------------------------------------------

  registry.add(
    server,
    {
      method: "GET",
      url: "/health/live",
      summary: "Liveness. Proves the process is running; never touches a dependency.",
      tag: "health",
      response: z.object({ status: z.literal("ok"), service: z.string() }),
      errors: [],
    },
    async () => ({ status: "ok" as const, service: config.serviceName }),
  );

  registry.add(
    server,
    {
      method: "GET",
      url: "/health/ready",
      summary:
        "Readiness. Requires the database to answer and every migration this build needs to be applied.",
      tag: "health",
      response: z.object({
        status: z.enum(["ready", "not_ready"]),
        database: z.enum(["up", "down"]),
        schema: z.object({
          compatible: z.boolean(),
          applied: z.array(z.string()),
          missing: z.array(z.string()),
        }),
      }),
      errors: [],
    },
    async ({ reply }) => {
      // A TCP listener is not readiness. The database has to answer a query, and the schema has to
      // hold every migration this build was written against — a half-migrated database produces
      // failures that read as product bugs.
      try {
        const schema = await checkSchema(sql, context.migrationsDir);
        if (!schema.compatible) reply.status(503);
        return {
          status: (schema.compatible ? "ready" : "not_ready") as "ready" | "not_ready",
          database: "up" as const,
          schema: {
            compatible: schema.compatible,
            applied: [...schema.applied],
            missing: [...schema.missing],
          },
        };
      } catch {
        reply.status(503);
        return {
          status: "not_ready" as const,
          database: "down" as const,
          schema: { compatible: false, applied: [], missing: [] },
        };
      }
    },
  );

  registry.add(
    server,
    {
      method: "GET",
      url: "/health/dependencies",
      summary:
        "Dependency report. SigNoz may be degraded without taking readiness down (PRD section 15.1).",
      tag: "health",
      response: z.object({
        database: z.object({ status: z.enum(["up", "down"]) }),
        signoz: z.object({
          status: z.enum(["up", "degraded", "down"]),
          missingTools: z.array(z.string()),
        }),
        jobs: z.object({
          status: z.enum(["ok", "stalled", "unknown"]),
          queued: z.number(),
          running: z.number(),
          oldestQueuedSeconds: z.number().nullable(),
          expiredLeases: z.number(),
          stalledAfterSeconds: z.number(),
        }),
      }),
      errors: [],
    },
    async () => {
      let database: "up" | "down" = "up";
      try {
        await sql`select 1`;
      } catch {
        database = "down";
      }

      // A worker that has stopped claiming work takes nothing else down with it: the API answers,
      // the database answers, SigNoz answers, and jobs simply accumulate. `stalled` is the only
      // signal that says so, so it is reported here rather than inferred from a job page by hand.
      let jobs: {
        status: "ok" | "stalled" | "unknown";
        queued: number;
        running: number;
        oldestQueuedSeconds: number | null;
        expiredLeases: number;
        stalledAfterSeconds: number;
      } = {
        status: "unknown",
        queued: 0,
        running: 0,
        oldestQueuedSeconds: null,
        expiredLeases: 0,
        stalledAfterSeconds: config.jobStalledAfterSeconds,
      };
      try {
        const depth = await jobQueueDepth(sql);
        const stalled =
          depth.oldestQueuedSeconds !== null &&
          depth.oldestQueuedSeconds >= config.jobStalledAfterSeconds;
        jobs = {
          status: stalled ? "stalled" : "ok",
          queued: depth.queued,
          running: depth.running,
          oldestQueuedSeconds: depth.oldestQueuedSeconds,
          expiredLeases: depth.expiredLeases,
          stalledAfterSeconds: config.jobStalledAfterSeconds,
        };
      } catch {
        // Left `unknown`. The database section already reports the underlying failure, and claiming
        // `ok` for a queue that could not be read would be the false green this product exists to
        // stop.
      }

      let signoz: { status: "up" | "degraded" | "down"; missingTools: string[] } = {
        status: "down",
        missingTools: [],
      };
      const gateway = context.gateway();
      try {
        const snapshot = await gateway.verify();
        signoz = {
          status: snapshot.satisfied ? "up" : "degraded",
          missingTools: [...snapshot.requiredMissing],
        };
      } catch {
        signoz = { status: "down", missingTools: [] };
      } finally {
        await gateway.close().catch(() => {});
      }

      return { database: { status: database }, signoz, jobs };
    },
  );

  // -------------------------------------------------------------------------
  // 15.2 Setup and SigNoz
  // -------------------------------------------------------------------------

  const CONNECTION_NAME = "default";

  registry.add(
    server,
    {
      method: "POST",
      url: "/api/setup/signoz/verify",
      summary:
        "Connects to the SigNoz MCP Server, discovers its tools (PRD section 16.4) and stores the snapshot.",
      tag: "setup",
      body: z.object({}).optional(),
      response: z.object({
        connectionId: z.string(),
        status: z.enum(["connected", "degraded"]),
        server: z.object({ name: z.string(), version: z.string() }).nullable(),
        toolNames: z.array(z.string()),
        requiredMissing: z.array(z.string()),
        satisfied: z.boolean(),
        lastVerifiedAt: IsoDate,
      }),
      errors: ["SIGNOZ_UNREACHABLE", "MCP_UNAVAILABLE", "MCP_TOOL_MISSING"],
    },
    async () => {
      const gateway = context.gateway();
      try {
        const snapshot = await gateway.verify();
        const verifiedAt = context.now();
        const connection = await sql.begin(async (tx) => {
          const stored = await upsertSignozConnection(tx, {
            name: CONNECTION_NAME,
            baseUrl: config.signozUrl,
            mcpUrl: config.signozMcpUrl,
            // The reference, never the key (PRD section 14.2).
            apiKeySecretReference: config.signozApiKeySecretReference,
            status: snapshot.satisfied ? "connected" : "degraded",
            lastVerifiedAt: verifiedAt,
            capabilities: snapshot,
          });
          await recordAudit(tx, {
            projectId: null,
            actorType: "user",
            eventType: "signoz.connection.verified",
            entityType: "signoz_connection",
            entityId: stored.id,
            details: { satisfied: snapshot.satisfied, missing: snapshot.requiredMissing },
          });
          return stored;
        });

        return {
          connectionId: connection.id,
          status: (snapshot.satisfied ? "connected" : "degraded") as "connected" | "degraded",
          server: snapshot.server ? { ...snapshot.server } : null,
          toolNames: [...snapshot.toolNames],
          requiredMissing: [...snapshot.requiredMissing],
          satisfied: snapshot.satisfied,
          lastVerifiedAt: verifiedAt.toISOString(),
        };
      } finally {
        await gateway.close().catch(() => {});
      }
    },
  );

  registry.add(
    server,
    {
      method: "GET",
      url: "/api/setup/signoz/capabilities",
      summary: "The stored capability snapshot from the last verification.",
      tag: "setup",
      response: z.object({
        connectionId: z.string().nullable(),
        status: z.string(),
        lastVerifiedAt: IsoDate.nullable(),
        capabilities: z.unknown(),
      }),
      errors: [],
    },
    async () => {
      const connection = await findSignozConnectionByName(sql, CONNECTION_NAME);
      if (!connection) {
        return {
          connectionId: null,
          status: "unverified",
          lastVerifiedAt: null,
          capabilities: null,
        };
      }
      return {
        connectionId: connection.id,
        status: connection.status,
        lastVerifiedAt: iso(connection.lastVerifiedAt),
        capabilities: connection.capabilities,
      };
    },
  );

  registry.add(
    server,
    {
      method: "POST",
      url: "/api/setup/signoz/discover-fields",
      summary: "Live trace field catalogue from the connected SigNoz tenant (FR-002, SL-051).",
      tag: "setup",
      body: z.object({ searchText: z.string().min(1).max(200).optional() }),
      response: z.object({
        complete: z.boolean(),
        fields: z.array(
          z.object({ name: z.string(), fieldContext: z.string(), fieldDataType: z.string() }),
        ),
      }),
      errors: [
        "SIGNOZ_UNREACHABLE",
        "MCP_UNAVAILABLE",
        "MCP_RESPONSE_INVALID",
        "TRACE_QUERY_FAILED",
      ],
    },
    async ({ body }) => {
      const gateway = context.gateway();
      try {
        const fields = await gateway.discoverFields(body.searchText ?? null);
        return { complete: body.searchText === undefined, fields: fields.map((f) => ({ ...f })) };
      } finally {
        await gateway.close().catch(() => {});
      }
    },
  );

  // -------------------------------------------------------------------------
  // 15.3 Projects (FR-001)
  // -------------------------------------------------------------------------

  registry.add(
    server,
    {
      method: "GET",
      url: "/api/projects",
      summary: "Projects, newest identifier last, cursor paginated.",
      tag: "projects",
      query: PageQuery,
      response: page(ProjectResponse),
      errors: [],
    },
    async ({ query }) => {
      const result = await listProjects(sql, toPageRequest(query));
      return { items: result.items.map(projectDto), nextCursor: result.nextCursor };
    },
  );

  registry.add(
    server,
    {
      method: "POST",
      url: "/api/projects",
      summary: "Creates a project. FR-001: a duplicate slug is rejected.",
      tag: "projects",
      body: z.object({
        name: z.string().trim().min(1).max(120),
        slug: z.string().min(1).max(120).regex(SLUG, "a slug must be lower-kebab-case"),
        description: z.string().max(2000).optional(),
        defaultEnvironment: z.string().trim().min(1).max(120).optional(),
        signozConnectionId: z.string().optional(),
      }),
      response: ProjectResponse,
      successStatus: 201,
      errors: ["CONTRACT_CONFLICT"],
    },
    async ({ body }) => {
      const existing = await findProjectBySlug(sql, body.slug);
      if (existing) {
        throw new FlightRulesError("CONTRACT_CONFLICT", {
          message: "A project with that slug already exists.",
          details: { slug: body.slug, projectId: existing.id },
        });
      }
      const created = await sql.begin(async (tx) => {
        const project = await createProject(tx, {
          name: body.name,
          slug: body.slug,
          ...(body.description === undefined ? {} : { description: body.description }),
          ...(body.defaultEnvironment === undefined
            ? {}
            : { defaultEnvironment: body.defaultEnvironment }),
          ...(body.signozConnectionId === undefined
            ? {}
            : { signozConnectionId: body.signozConnectionId }),
        });
        await recordAudit(tx, {
          projectId: project.id,
          actorType: "user",
          eventType: "project.created",
          entityType: "project",
          entityId: project.id,
          details: { slug: project.slug },
        });
        return project;
      });
      return projectDto(created);
    },
  );

  registry.add(
    server,
    {
      method: "GET",
      url: "/api/projects/:projectId",
      summary: "One project.",
      tag: "projects",
      response: ProjectResponse,
      errors: [],
    },
    async ({ params }) => {
      const id = requireUuid(params["projectId"] ?? "", "project");
      const project = await findProject(sql, id);
      if (!project) throw notFound("project", id);
      return projectDto(project);
    },
  );

  registry.add(
    server,
    {
      method: "PATCH",
      url: "/api/projects/:projectId",
      summary: "Updates a project. The slug is immutable: it is a metric dimension.",
      tag: "projects",
      body: z.object({
        name: z.string().trim().min(1).max(120).optional(),
        description: z.string().max(2000).optional(),
        defaultEnvironment: z.string().trim().min(1).max(120).optional(),
        signozConnectionId: z.string().nullable().optional(),
      }),
      response: ProjectResponse,
      errors: [],
    },
    async ({ params, body }) => {
      const id = requireUuid(params["projectId"] ?? "", "project");
      const updated = await sql.begin(async (tx) => {
        const project = await updateProject(tx, id, body);
        if (!project) return null;
        await recordAudit(tx, {
          projectId: project.id,
          actorType: "user",
          eventType: "project.updated",
          entityType: "project",
          entityId: project.id,
          details: { fields: Object.keys(body).sort() },
        });
        return project;
      });
      if (!updated) throw notFound("project", id);
      return projectDto(updated);
    },
  );

  registry.add(
    server,
    {
      method: "DELETE",
      url: "/api/projects/:projectId",
      summary:
        "Deletes a project. PRD section 15.3 requires explicit confirmation; SigNoz artefacts are left alone.",
      tag: "projects",
      body: z.object({
        confirmSlug: z.string().min(1),
        deleteSignozArtifacts: z.boolean().optional(),
      }),
      response: z.object({ deleted: z.boolean(), signozArtifactsRetained: z.number() }),
      errors: ["VALIDATION_FAILED"],
    },
    async ({ params, body }) => {
      const id = requireUuid(params["projectId"] ?? "", "project");
      const project = await findProject(sql, id);
      if (!project) throw notFound("project", id);
      if (body.confirmSlug !== project.slug) {
        throw new FlightRulesError("VALIDATION_FAILED", {
          message: "Deleting a project requires its slug as confirmation.",
          details: { field: "confirmSlug" },
        });
      }
      if (body.deleteSignozArtifacts === true) {
        throw new FlightRulesError("VALIDATION_FAILED", {
          message:
            "Deleting managed SigNoz artefacts is a separate operation and is not implemented until Phase 10.",
          details: { field: "deleteSignozArtifacts" },
        });
      }
      const retained = (await listArtifacts(sql, id)).length;
      const deleted = await sql.begin(async (tx) => {
        // Audited before the delete, because the cascade removes the project's audit rows with it.
        await recordAudit(tx, {
          projectId: null,
          actorType: "user",
          eventType: "project.deleted",
          entityType: "project",
          entityId: id,
          details: { slug: project.slug, signozArtifactsRetained: retained },
        });
        return deleteProject(tx, id);
      });
      return { deleted, signozArtifactsRetained: retained };
    },
  );

  // -------------------------------------------------------------------------
  // 15.4 Agents (FR-002)
  // -------------------------------------------------------------------------

  const agentDto = (agent: Awaited<ReturnType<typeof createAgent>>) => ({
    id: agent.id,
    projectId: agent.projectId,
    name: agent.name,
    agentKey: agent.agentKey,
    workflowNameMatcher: agent.workflowNameMatcher,
    rootSpanMatcher: agent.rootSpanMatcher as Record<string, unknown>,
    serviceMatchers: [...agent.serviceMatchers],
    toolOperationMatcher: agent.toolOperationMatcher ? [...agent.toolOperationMatcher] : null,
    completionCriteria: agent.completionCriteria as Record<string, unknown>,
    releaseAttributeKey: agent.releaseAttributeKey,
    environmentAttributeKey: agent.environmentAttributeKey,
    normaliserConfigId: agent.normaliserConfigId,
    createdAt: agent.createdAt.toISOString(),
    updatedAt: agent.updatedAt.toISOString(),
  });

  registry.add(
    server,
    {
      method: "GET",
      url: "/api/projects/:projectId/agents",
      summary: "Agents in a project.",
      tag: "agents",
      query: PageQuery,
      response: page(AgentResponse),
      errors: [],
    },
    async ({ params, query }) => {
      const projectId = requireUuid(params["projectId"] ?? "", "project");
      if (!(await findProject(sql, projectId))) throw notFound("project", projectId);
      const result = await listAgents(sql, projectId, toPageRequest(query));
      return { items: result.items.map(agentDto), nextCursor: result.nextCursor };
    },
  );

  registry.add(
    server,
    {
      method: "POST",
      url: "/api/projects/:projectId/agents",
      summary: "Registers an agent. FR-002: registration fails without a release discriminator.",
      tag: "agents",
      body: z.object({
        name: z.string().trim().min(1).max(120),
        agentKey: z
          .string()
          .min(1)
          .max(64)
          .regex(AGENT_KEY, "an agent key must match [a-z0-9][a-z0-9._-]*"),
        workflowNameMatcher: z.string().trim().min(1).max(200),
        rootSpanMatcher: z
          .object({
            name: z.string().min(1).max(200).optional(),
            service: z.string().min(1).max(200).optional(),
          })
          .optional(),
        serviceMatchers: z.array(z.string().min(1).max(200)).max(50).optional(),
        toolOperationMatcher: z.array(z.string().min(1).max(200)).max(100).optional(),
        completionCriteria: z
          .object({
            requireCompleteTrace: z.boolean().optional(),
            maxSpans: z.number().int().min(1).max(100_000).optional(),
          })
          .optional(),
        // FR-002 makes this mandatory; the schema is where the requirement is enforced.
        releaseAttributeKey: z.string().trim().min(1).max(120),
        environmentAttributeKey: z.string().trim().min(1).max(120),
      }),
      response: AgentResponse,
      successStatus: 201,
      errors: ["CONTRACT_CONFLICT"],
    },
    async ({ params, body }) => {
      const projectId = requireUuid(params["projectId"] ?? "", "project");
      if (!(await findProject(sql, projectId))) throw notFound("project", projectId);

      const created = await sql
        .begin(async (tx) => {
          const agent = await createAgent(tx, {
            projectId,
            name: body.name,
            agentKey: body.agentKey,
            workflowNameMatcher: body.workflowNameMatcher,
            rootSpanMatcher: body.rootSpanMatcher,
            serviceMatchers: body.serviceMatchers,
            toolOperationMatcher: body.toolOperationMatcher,
            completionCriteria: body.completionCriteria,
            releaseAttributeKey: body.releaseAttributeKey,
            environmentAttributeKey: body.environmentAttributeKey,
          });
          await recordAudit(tx, {
            projectId,
            actorType: "user",
            eventType: "agent.created",
            entityType: "agent",
            entityId: agent.id,
            details: { agentKey: agent.agentKey },
          });
          return agent;
        })
        .catch((error: unknown) => {
          if (
            typeof error === "object" &&
            error !== null &&
            (error as { code?: string }).code === "23505"
          ) {
            throw new FlightRulesError("CONTRACT_CONFLICT", {
              message: "An agent with that key already exists in this project.",
              details: { agentKey: body.agentKey },
            });
          }
          throw error;
        });
      return agentDto(created);
    },
  );

  registry.add(
    server,
    {
      method: "GET",
      url: "/api/agents/:agentId",
      summary: "One agent.",
      tag: "agents",
      response: AgentResponse,
      errors: [],
    },
    async ({ params }) => {
      const id = requireUuid(params["agentId"] ?? "", "agent");
      const agent = await findAgent(sql, id);
      if (!agent) throw notFound("agent", id);
      return agentDto(agent);
    },
  );

  registry.add(
    server,
    {
      method: "PATCH",
      url: "/api/agents/:agentId",
      summary: "Updates an agent. The agent key is immutable.",
      tag: "agents",
      body: z.object({
        name: z.string().trim().min(1).max(120).optional(),
        workflowNameMatcher: z.string().trim().min(1).max(200).optional(),
        rootSpanMatcher: z
          .object({
            name: z.string().min(1).max(200).optional(),
            service: z.string().min(1).max(200).optional(),
          })
          .optional(),
        serviceMatchers: z.array(z.string().min(1).max(200)).max(50).optional(),
        toolOperationMatcher: z.array(z.string().min(1).max(200)).max(100).nullable().optional(),
        completionCriteria: z
          .object({
            requireCompleteTrace: z.boolean().optional(),
            maxSpans: z.number().int().min(1).max(100_000).optional(),
          })
          .optional(),
        releaseAttributeKey: z.string().trim().min(1).max(120).optional(),
        environmentAttributeKey: z.string().trim().min(1).max(120).optional(),
      }),
      response: AgentResponse,
      errors: [],
    },
    async ({ params, body }) => {
      const id = requireUuid(params["agentId"] ?? "", "agent");
      const updated = await sql.begin(async (tx) => {
        const agent = await updateAgent(tx, id, {
          name: body.name,
          workflowNameMatcher: body.workflowNameMatcher,
          rootSpanMatcher: body.rootSpanMatcher,
          serviceMatchers: body.serviceMatchers,
          toolOperationMatcher: body.toolOperationMatcher,
          completionCriteria: body.completionCriteria,
          releaseAttributeKey: body.releaseAttributeKey,
          environmentAttributeKey: body.environmentAttributeKey,
        });
        if (!agent) return null;
        await recordAudit(tx, {
          projectId: agent.projectId,
          actorType: "user",
          eventType: "agent.updated",
          entityType: "agent",
          entityId: agent.id,
          details: { fields: Object.keys(body).sort() },
        });
        return agent;
      });
      if (!updated) throw notFound("agent", id);
      return agentDto(updated);
    },
  );

  registry.add(
    server,
    {
      method: "POST",
      url: "/api/agents/:agentId/preview-traces",
      summary:
        "FR-002: a preview query showing matching recent traces from the connected SigNoz tenant.",
      tag: "agents",
      body: z.object({
        releaseId: z.string().min(1).max(200).optional(),
        environment: z.string().min(1).max(120).optional(),
        lookbackMinutes: z.number().int().min(1).max(10_080).optional(),
        limit: z.number().int().min(1).max(50).optional(),
      }),
      response: z.object({
        filter: z.string(),
        windowStart: IsoDate,
        windowEnd: IsoDate,
        items: z.array(
          z.object({
            traceId: z.string(),
            name: z.string(),
            serviceName: z.string().nullable(),
            releaseId: z.string().nullable(),
          }),
        ),
      }),
      errors: [
        "SIGNOZ_UNREACHABLE",
        "MCP_UNAVAILABLE",
        "TRACE_QUERY_FAILED",
        "MCP_RESPONSE_INVALID",
      ],
    },
    async ({ params, body }) => {
      const id = requireUuid(params["agentId"] ?? "", "agent");
      const agent = await findAgent(sql, id);
      if (!agent) throw notFound("agent", id);

      const endMs = context.now().getTime();
      const startMs = endMs - (body.lookbackMinutes ?? 360) * 60_000;
      // Built from the agent's own stored matchers and a bounded set of quoted literals, never
      // from raw caller text: the release and environment values are validated above and are the
      // only caller-supplied parts.
      const clauses = [
        `name = '${escapeLiteral(agent.rootSpanMatcher.name ?? agent.workflowNameMatcher)}'`,
      ];
      if (body.releaseId !== undefined) {
        clauses.push(`${agent.releaseAttributeKey} = '${escapeLiteral(body.releaseId)}'`);
      }
      const filter = clauses.join(" AND ");

      const gateway = context.gateway();
      try {
        const rows = await gateway.previewTraces({
          filter,
          startMs,
          endMs,
          limit: body.limit ?? 10,
        });
        return {
          filter,
          windowStart: new Date(startMs).toISOString(),
          windowEnd: new Date(endMs).toISOString(),
          items: rows.map((row) => ({
            traceId: row.traceId,
            name: row.name,
            serviceName: row.serviceName,
            releaseId: row.releaseId,
          })),
        };
      } finally {
        await gateway.close().catch(() => {});
      }
    },
  );

  // -------------------------------------------------------------------------
  // 15.10 Jobs
  // -------------------------------------------------------------------------

  registry.add(
    server,
    {
      method: "GET",
      url: "/api/jobs/:jobId",
      summary: "Job state, including its result or its typed failure.",
      tag: "jobs",
      response: JobResponse,
      errors: [],
    },
    async ({ params }) => {
      const id = requireUuid(params["jobId"] ?? "", "job");
      const job = await findJob(sql, id);
      if (!job) throw notFound("job", id);
      return jobDto(job);
    },
  );

  registry.add(
    server,
    {
      method: "GET",
      url: "/api/jobs/:jobId/events",
      summary:
        "Progress events for a job, in order. Persisted on the job row, so they survive a restart.",
      tag: "jobs",
      response: z.object({
        jobId: z.string(),
        status: z.string(),
        stage: z.string().nullable(),
        events: z.array(
          z.object({
            index: z.number(),
            stage: z.string(),
            detail: z.string(),
            at: z.string(),
          }),
        ),
      }),
      errors: [],
    },
    async ({ params }) => {
      const id = requireUuid(params["jobId"] ?? "", "job");
      const job = await findJob(sql, id);
      if (!job) throw notFound("job", id);
      return {
        jobId: job.id,
        status: job.status,
        stage: job.progressStage,
        events: job.progressEvents.map((event) => ({ ...event })),
      };
    },
  );
}

/**
 * Escapes a single-quoted SigNoz filter literal.
 *
 * The filter grammar is SigNoz's, not SQL's, and the MCP client sends it as data in a JSON body —
 * but a value carrying a quote would still change which traces the preview returns, so quotes are
 * doubled and the value is length-bounded by the request schema above.
 */
function escapeLiteral(value: string): string {
  return value.replaceAll("'", "''");
}
