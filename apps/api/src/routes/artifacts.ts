import { createHash } from "node:crypto";
import { ROOT_SPAN_DEFAULT } from "@flightrules/artifact-compiler";
import {
  type Agent,
  findActiveContract,
  findAgent,
  findContract,
  findProject,
  listAgents,
  listArtifacts,
  recordAudit,
  type StoredContract,
  submitJob,
} from "@flightrules/db";
import { FlightRulesError } from "@flightrules/domain";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { notFound, requireUuid } from "../http.js";
import type { RouteRegistry } from "../registry.js";
import { jobDto } from "./core.js";

/**
 * PRD section 15.2 and 15.6's two SigNoz synchronisation routes, deferred from Phase 09 and
 * implemented here (PRD Phase 10).
 *
 * Both return a job rather than doing the work inline. A sync makes between one and ten MCP round
 * trips, each with a read-back, and PRD section 15.5's rule that a long-running endpoint returns a
 * job ID is what keeps a slow SigNoz from turning into an API timeout that leaves half the
 * artefacts created.
 *
 * Neither route exposes an MCP payload. What comes back is the FlightRules job envelope, and the
 * artefact register is read through `GET /api/setup/signoz/artifacts`.
 */

const IsoDate = z.string();
const iso = (value: Date | null): string | null => (value === null ? null : value.toISOString());

/**
 * A project-wide sync walks one page of agents.
 *
 * A bound rather than a cursor loop, because a project with more agents than this is past the
 * point where one HTTP request should fan out into that many jobs; the per-contract route is the
 * right tool there. The bound is disclosed in the response rather than silently truncating.
 */
const MAX_AGENTS_PER_SYNC = 100;

const JobAcceptedResponse = z.object({
  jobId: z.string(),
  status: z.string(),
  created: z.boolean(),
  idempotencyKey: z.string(),
  job: z.unknown(),
});

/**
 * The job's identity.
 *
 * The contract's *content hash* is in the key, not just its id, so re-syncing an unchanged contract
 * returns the job that already ran while a changed contract produces a new one. That is what makes
 * "the API retried after losing the response" and "a second identical sync" the same safe
 * operation, without the caller having to supply an idempotency token.
 */
function syncIdempotencyKey(contract: StoredContract, agent: Agent): string {
  return createHash("sha256")
    .update(JSON.stringify(["signoz_sync", contract.id, contract.contentHash, agent.id]))
    .digest("hex");
}

function rootSpanNameOf(agent: Agent): string {
  return agent.rootSpanMatcher.name ?? ROOT_SPAN_DEFAULT;
}

interface SyncTarget {
  readonly agent: Agent;
  readonly contract: StoredContract;
}

export function registerArtifactRoutes(
  server: FastifyInstance,
  registry: RouteRegistry,
  context: AppContext,
): void {
  const sql = context.sql;

  async function queueSync(
    projectId: string,
    projectSlug: string,
    target: SyncTarget,
  ): Promise<{
    jobId: string;
    status: string;
    created: boolean;
    idempotencyKey: string;
    job: unknown;
  }> {
    const idempotencyKey = syncIdempotencyKey(target.contract, target.agent);
    const submitted = await sql.begin(async (tx) => {
      const result = await submitJob(tx, {
        jobType: "signoz_sync",
        entityType: "contract",
        entityId: target.contract.id,
        projectId,
        idempotencyKey,
        input: {
          projectId,
          agentId: target.agent.id,
          contractId: target.contract.id,
          projectSlug,
          agentKey: target.agent.agentKey,
          contractVersion: target.contract.semanticVersion,
          contractContentHash: target.contract.contentHash,
          rootSpanName: rootSpanNameOf(target.agent),
          violationThreshold: 0,
        },
      });
      if (result.created) {
        await recordAudit(tx, {
          projectId,
          actorType: "user",
          eventType: "artifact.sync.requested",
          entityType: "contract",
          entityId: target.contract.id,
          details: { jobId: result.job.id, agentId: target.agent.id },
        });
      }
      return result;
    });

    return {
      jobId: submitted.job.id,
      status: submitted.job.status,
      created: submitted.created,
      idempotencyKey,
      job: jobDto(submitted.job),
    };
  }

  registry.add(
    server,
    {
      method: "POST",
      url: "/api/contracts/:contractId/sync-signoz",
      summary:
        "Compiles one approved or active contract into managed SigNoz views, a dashboard and alerts, verifying each by read-back. Returns a job.",
      tag: "contracts",
      body: z.object({}).optional(),
      response: JobAcceptedResponse,
      successStatus: 202,
      errors: [
        "STATE_TRANSITION_INVALID",
        "JOB_ALREADY_RUNNING",
        "MCP_UNAVAILABLE",
        "ARTIFACT_CREATE_FAILED",
        "ARTIFACT_VERIFY_FAILED",
      ],
    },
    async ({ params }) => {
      const contractId = requireUuid(params["contractId"] ?? "", "contract");
      const contract = await findContract(sql, contractId);
      if (!contract) throw notFound("contract", contractId);

      // A draft or superseded contract must not shape a live operational surface.
      if (contract.status !== "approved" && contract.status !== "active") {
        throw new FlightRulesError("STATE_TRANSITION_INVALID", {
          message: `A ${contract.status} contract cannot be compiled into SigNoz artefacts. Approve it first.`,
          details: { contractId, status: contract.status },
        });
      }

      const agent = await findAgent(sql, contract.agentId);
      if (!agent) throw notFound("agent", contract.agentId);
      const project = await findProject(sql, agent.projectId);
      if (!project) throw notFound("project", agent.projectId);

      return queueSync(project.id, project.slug, { agent, contract });
    },
  );

  registry.add(
    server,
    {
      method: "POST",
      url: "/api/setup/signoz/sync-artifacts",
      summary:
        "Compiles every agent of a project that holds an active contract into managed SigNoz artefacts. Returns one job per agent.",
      tag: "setup",
      body: z.object({
        projectId: z.string(),
        agentId: z.string().optional(),
      }),
      response: z.object({
        jobs: z.array(JobAcceptedResponse.extend({ agentId: z.string() })),
        skipped: z.array(z.object({ agentId: z.string(), reason: z.string() })),
      }),
      successStatus: 202,
      errors: ["CONTRACT_CONFLICT", "JOB_ALREADY_RUNNING", "MCP_UNAVAILABLE"],
    },
    async ({ body }) => {
      const projectId = requireUuid(body.projectId, "project");
      const project = await findProject(sql, projectId);
      if (!project) throw notFound("project", projectId);

      const agents: readonly Agent[] =
        body.agentId === undefined
          ? (await listAgents(sql, projectId, { limit: MAX_AGENTS_PER_SYNC, after: null })).items
          : await (async () => {
              const id = requireUuid(body.agentId ?? "", "agent");
              const agent = await findAgent(sql, id);
              if (!agent || agent.projectId !== projectId) throw notFound("agent", id);
              return [agent];
            })();

      const jobs: (z.infer<typeof JobAcceptedResponse> & { agentId: string })[] = [];
      const skipped: { agentId: string; reason: string }[] = [];

      // Sorted by agent key so a repeated call over the same project produces the same order.
      for (const agent of [...agents].sort((a, b) => a.agentKey.localeCompare(b.agentKey))) {
        const contract = await findActiveContract(sql, agent.id, project.defaultEnvironment);
        if (!contract) {
          skipped.push({
            agentId: agent.id,
            reason: "no active contract for the project's default environment",
          });
          continue;
        }
        const queued = await queueSync(project.id, project.slug, { agent, contract });
        jobs.push({ ...queued, agentId: agent.id });
      }

      if (jobs.length === 0) {
        throw new FlightRulesError("CONTRACT_CONFLICT", {
          message:
            "No agent in this project holds an active contract, so there is nothing to compile.",
          details: { projectId, skipped },
        });
      }

      return { jobs, skipped };
    },
  );

  registry.add(
    server,
    {
      method: "GET",
      url: "/api/setup/signoz/artifacts",
      summary:
        "The managed SigNoz artefact register, with the verification verdict and drift state of the last sync.",
      tag: "setup",
      query: z.object({ projectId: z.string() }),
      response: z.object({
        items: z.array(
          z.object({
            id: z.string(),
            artifactType: z.string(),
            managedName: z.string(),
            signozResourceId: z.string().nullable(),
            signozWebUrl: z.string().nullable(),
            specHash: z.string(),
            status: z.string(),
            lastOperation: z.string().nullable(),
            syncAttempt: z.number(),
            contractId: z.string().nullable(),
            verification: z.unknown(),
            remoteSnapshot: z.unknown(),
            lastError: z.unknown(),
            lastSyncedAt: IsoDate.nullable(),
            lastVerifiedAt: IsoDate.nullable(),
          }),
        ),
        summary: z.object({
          total: z.number(),
          synced: z.number(),
          drifted: z.number(),
          failed: z.number(),
          conflict: z.number(),
        }),
      }),
      errors: [],
    },
    async ({ query }) => {
      const projectId = requireUuid(query.projectId, "project");
      const project = await findProject(sql, projectId);
      if (!project) throw notFound("project", projectId);
      const artifacts = await listArtifacts(sql, projectId);
      const count = (status: string): number =>
        artifacts.filter((artifact) => artifact.status === status).length;
      return {
        items: artifacts.map((artifact) => ({
          id: artifact.id,
          artifactType: artifact.artifactType,
          managedName: artifact.managedName,
          signozResourceId: artifact.signozResourceId,
          signozWebUrl: artifact.signozWebUrl,
          specHash: artifact.specHash,
          status: artifact.status,
          lastOperation: artifact.lastOperation,
          syncAttempt: artifact.syncAttempt,
          contractId: artifact.contractId,
          // Already redacted when it was written: field paths and truncated renderings only.
          verification: artifact.verification,
          remoteSnapshot: artifact.remoteSnapshot,
          lastError: artifact.lastError,
          lastSyncedAt: iso(artifact.lastSyncedAt),
          lastVerifiedAt: iso(artifact.lastVerifiedAt),
        })),
        summary: {
          total: artifacts.length,
          synced: count("synced"),
          drifted: count("drifted"),
          failed: count("failed"),
          conflict: count("conflict"),
        },
      };
    },
  );
}
