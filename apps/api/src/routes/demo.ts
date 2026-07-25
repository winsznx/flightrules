import { createHash } from "node:crypto";
import { resolveSelection, selectionHash } from "@flightrules/baseline-miner";
import { EVALUATOR_VERSION } from "@flightrules/contract-engine";
import {
  createAgent,
  createEvaluation,
  createProject,
  deleteProject,
  findActiveContract,
  findAgentByKey,
  findProjectBySlug,
  listBaselines,
  listContracts,
  observeRelease,
  recordAudit,
  submitJob,
  toPageRequest,
} from "@flightrules/db";
import { FlightRulesError } from "@flightrules/domain";
import { DEFAULT_NORMALISER_CONFIG, identityOf } from "@flightrules/normaliser";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context.js";
import type { RouteRegistry } from "../registry.js";
import { jobDto } from "./core.js";

/**
 * The demo surface (PRD section 15.9, FR-020).
 *
 * Every route here is refused unless `DEMO_MODE` is enabled, which PRD section 18.2 lists as a
 * required control: these endpoints create load, reset state and are meaningless outside the demo.
 * The guard is the first statement in every handler rather than a plugin hook, so it cannot be
 * bypassed by a route registered later.
 *
 * Nothing here is a second implementation of the product. Each route builds the same job the
 * ordinary API would and submits it under the same idempotency rule.
 */

export const DEMO_PROJECT_SLUG = "demo-commerce";
export const DEMO_AGENT_KEY = "refund-agent";
export const DEMO_ROOT_SPAN = "refund.request";
export const DEMO_WORKFLOW = "refund-workflow";
export const DEMO_RELEASE_V1 = "refund-agent-v1";
export const DEMO_RELEASE_V2 = "refund-agent-v2";

const IsoDate = z.string();

const JobAccepted = z.object({
  jobId: z.string(),
  status: z.string(),
  created: z.boolean(),
  idempotencyKey: z.string(),
  job: z.unknown(),
});

export function registerDemoRoutes(
  server: FastifyInstance,
  registry: RouteRegistry,
  context: AppContext,
): void {
  const { sql, config } = context;
  const normaliser = identityOf(DEFAULT_NORMALISER_CONFIG);

  const requireDemoMode = (): void => {
    if (!config.demoMode) throw new FlightRulesError("DEMO_DISABLED");
  };

  const requireDemoAgent = async () => {
    const project = await findProjectBySlug(sql, DEMO_PROJECT_SLUG);
    if (!project) {
      throw new FlightRulesError("CONFIG_INVALID", {
        message: "The demo project does not exist. POST /api/demo/reset creates it.",
      });
    }
    const agent = await findAgentByKey(sql, project.id, DEMO_AGENT_KEY);
    if (!agent) {
      throw new FlightRulesError("CONFIG_INVALID", {
        message: "The demo agent does not exist. POST /api/demo/reset creates it.",
      });
    }
    return { project, agent };
  };

  registry.add(
    server,
    {
      method: "POST",
      url: "/api/demo/reset",
      summary:
        "FR-020: clears the demo's FlightRules data and reseeds the project and agent. SigNoz is untouched.",
      tag: "demo",
      body: z.object({ confirm: z.literal(true) }),
      response: z.object({
        projectId: z.string(),
        agentId: z.string(),
        deletedPreviousProject: z.boolean(),
      }),
      errors: ["DEMO_DISABLED"],
    },
    async () => {
      requireDemoMode();
      // The cascade removes agents, baselines, contracts, evaluations, violations and jobs for the
      // demo project only. `signoz_connections` is a separate table and survives, which is what
      // FR-020's "retain source configuration" means here.
      const result = await sql.begin(async (tx) => {
        const existing = await findProjectBySlug(tx, DEMO_PROJECT_SLUG);
        const deleted = existing ? await deleteProject(tx, existing.id) : false;

        const project = await createProject(tx, {
          name: "Demo Commerce",
          slug: DEMO_PROJECT_SLUG,
          description: "The refund-agent demo (PRD section 5).",
          defaultEnvironment: context.config.environmentName,
        });
        const agent = await createAgent(tx, {
          projectId: project.id,
          name: "Refund agent",
          agentKey: DEMO_AGENT_KEY,
          workflowNameMatcher: DEMO_WORKFLOW,
          rootSpanMatcher: { name: DEMO_ROOT_SPAN },
          serviceMatchers: [
            "flightrules-demo-agent",
            "flightrules-fraud-service",
            "flightrules-notification-service",
            "flightrules-order-service",
            "flightrules-payment-service",
            "flightrules-policy-service",
          ],
          completionCriteria: { requireCompleteTrace: true },
          releaseAttributeKey: "agent.release.id",
          environmentAttributeKey: "deployment.environment.name",
        });
        await recordAudit(tx, {
          projectId: project.id,
          actorType: "demo",
          eventType: "demo.reset",
          entityType: "project",
          entityId: project.id,
          details: { deletedPreviousProject: deleted },
        });
        return { project, agent, deleted };
      });

      return {
        projectId: result.project.id,
        agentId: result.agent.id,
        deletedPreviousProject: result.deleted,
      };
    },
  );

  const runRelease = async (
    releaseKey: string,
    body: { runs?: number | undefined; orderId?: string | undefined; runKey?: string | undefined },
  ) => {
    requireDemoMode();
    const { project, agent } = await requireDemoAgent();
    // A demo run genuinely produces new telemetry each time, so its identity is the caller's run
    // key. Without one the request is not idempotent and must not pretend to be: the key defaults
    // to the request time, which makes each submission a distinct job.
    const runKey = body.runKey ?? context.now().toISOString();
    const input = {
      releaseKey,
      orderId: body.orderId ?? "ord-98271",
      runs: body.runs ?? 1,
      runKey,
    };
    const idempotencyKey = createHash("sha256")
      .update(JSON.stringify([releaseKey, input.orderId, input.runs, runKey]))
      .digest("hex");

    const submitted = await sql.begin(async (tx) => {
      const result = await submitJob(tx, {
        jobType: "demo_run",
        entityType: "agent",
        entityId: agent.id,
        projectId: project.id,
        idempotencyKey,
        input,
      });
      if (result.created) {
        await recordAudit(tx, {
          projectId: project.id,
          actorType: "demo",
          eventType: "demo.run.requested",
          entityType: "agent",
          entityId: agent.id,
          details: { releaseKey, runs: input.runs, jobId: result.job.id },
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
  };

  const DemoRunBody = z.object({
    runs: z.number().int().min(1).max(200).optional(),
    orderId: z.string().min(1).max(64).optional(),
    runKey: z.string().min(1).max(120).optional(),
  });

  registry.add(
    server,
    {
      method: "POST",
      url: "/api/demo/run/v1",
      summary: "Runs the approved refund-agent-v1 release. Returns a job.",
      tag: "demo",
      body: DemoRunBody,
      response: JobAccepted,
      successStatus: 202,
      errors: ["DEMO_DISABLED", "CONFIG_INVALID"],
    },
    async ({ body }) => runRelease(DEMO_RELEASE_V1, body),
  );

  registry.add(
    server,
    {
      method: "POST",
      url: "/api/demo/run/v2",
      summary: "Runs the unsafe refund-agent-v2 canary. Returns a job.",
      tag: "demo",
      body: DemoRunBody,
      response: JobAccepted,
      successStatus: 202,
      errors: ["DEMO_DISABLED", "CONFIG_INVALID"],
    },
    async ({ body }) => runRelease(DEMO_RELEASE_V2, body),
  );

  registry.add(
    server,
    {
      method: "POST",
      url: "/api/demo/capture-baseline",
      summary: "Captures a baseline from recent refund-agent-v1 telemetry. Returns a job.",
      tag: "demo",
      body: z.object({
        lookbackMinutes: z.number().int().min(1).max(10_080).optional(),
        minimumRuns: z.number().int().min(1).max(5_000).optional(),
      }),
      response: JobAccepted,
      successStatus: 202,
      errors: ["DEMO_DISABLED", "CONFIG_INVALID", "JOB_ALREADY_RUNNING"],
    },
    async ({ body }) => {
      requireDemoMode();
      const { project, agent } = await requireDemoAgent();
      const endMs = context.now().getTime();
      const startMs = endMs - (body.lookbackMinutes ?? 360) * 60_000;

      const selectionInput = {
        projectKey: project.slug,
        agentKey: agent.agentKey,
        releaseId: DEMO_RELEASE_V1,
        environment: config.environmentName,
        startMs,
        endMs,
        minimumRuns: body.minimumRuns ?? 20,
        rootSpanName: DEMO_ROOT_SPAN,
        successfulRunsOnly: true,
        excludeMissingRootSpan: true,
        rareThreshold: 0.05,
        maxTraces: 1_000,
        representativesPerFamily: 3,
        maxSpansPerTrace: config.maxSpansPerTrace,
      };
      const idempotencyKey = selectionHash(resolveSelection(selectionInput));

      const submitted = await sql.begin(async (tx) => {
        const result = await submitJob(tx, {
          jobType: "baseline_mining",
          entityType: "agent",
          entityId: agent.id,
          projectId: project.id,
          idempotencyKey,
          input: {
            agentId: agent.id,
            projectId: project.id,
            ...selectionInput,
            releaseKey: selectionInput.releaseId,
          },
        });
        if (result.created) {
          await recordAudit(tx, {
            projectId: project.id,
            actorType: "demo",
            eventType: "baseline.requested",
            entityType: "agent",
            entityId: agent.id,
            details: { jobId: result.job.id, releaseKey: DEMO_RELEASE_V1 },
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
    },
  );

  registry.add(
    server,
    {
      method: "POST",
      url: "/api/demo/evaluate-v2",
      summary:
        "Evaluates recent refund-agent-v2 telemetry against the active contract. Returns a job.",
      tag: "demo",
      body: z.object({ lookbackMinutes: z.number().int().min(1).max(10_080).optional() }),
      response: JobAccepted.extend({ evaluationId: z.string() }),
      successStatus: 202,
      errors: ["DEMO_DISABLED", "CONFIG_INVALID", "CONTRACT_CONFLICT", "JOB_ALREADY_RUNNING"],
    },
    async ({ body }) => {
      requireDemoMode();
      const { project, agent } = await requireDemoAgent();
      const contract = await findActiveContract(sql, agent.id, project.defaultEnvironment);
      if (!contract) {
        throw new FlightRulesError("CONTRACT_CONFLICT", {
          message:
            "No contract is active for the demo agent. Approve and activate one before evaluating the canary.",
          details: { agentId: agent.id, environment: project.defaultEnvironment },
        });
      }

      const endMs = context.now().getTime();
      const startMs = endMs - (body.lookbackMinutes ?? 360) * 60_000;

      const release = await sql.begin((tx) =>
        observeRelease(tx, {
          agentId: agent.id,
          releaseKey: DEMO_RELEASE_V2,
          environment: project.defaultEnvironment,
          observedAt: new Date(endMs),
        }),
      );

      const idempotencyKey = createHash("sha256")
        .update(
          JSON.stringify([
            contract.id,
            contract.contentHash,
            release.id,
            "release",
            startMs,
            endMs,
            DEMO_ROOT_SPAN,
          ]),
        )
        .digest("hex");

      const result = await sql.begin(async (tx) => {
        const created = await createEvaluation(tx, {
          agentId: agent.id,
          contractId: contract.id,
          releaseId: release.id,
          scope: "release",
          evaluatorVersion: EVALUATOR_VERSION,
          normaliserVersion: normaliser.version,
          normaliserConfigHash: normaliser.configHash,
          contractContentHash: contract.contentHash,
          idempotencyKey,
          windowStart: new Date(startMs),
          windowEnd: new Date(endMs),
          jobId: null,
        });
        const submitted = await submitJob(tx, {
          jobType: "evaluation",
          entityType: "contract",
          entityId: contract.id,
          projectId: project.id,
          idempotencyKey,
          input: {
            agentId: agent.id,
            projectId: project.id,
            contractId: contract.id,
            evaluationId: created.evaluation.id,
            projectKey: project.slug,
            agentKey: agent.agentKey,
            releaseKey: DEMO_RELEASE_V2,
            environment: project.defaultEnvironment,
            scope: "release" as const,
            rootSpanName: DEMO_ROOT_SPAN,
            startMs,
            endMs,
            maxTraces: config.maxTracesPerEvaluation,
            maxSpansPerTrace: config.maxSpansPerTrace,
          },
        });
        if (submitted.created) {
          await recordAudit(tx, {
            projectId: project.id,
            actorType: "demo",
            eventType: "evaluation.requested",
            entityType: "evaluation",
            entityId: created.evaluation.id,
            details: { jobId: submitted.job.id, releaseKey: DEMO_RELEASE_V2 },
          });
        }
        return { submitted, evaluationId: created.evaluation.id };
      });

      return {
        jobId: result.submitted.job.id,
        status: result.submitted.job.status,
        created: result.submitted.created,
        idempotencyKey,
        evaluationId: result.evaluationId,
        job: jobDto(result.submitted.job),
      };
    },
  );

  registry.add(
    server,
    {
      method: "GET",
      url: "/api/demo/status",
      summary: "Demo state: whether the project, agent, a baseline and an active contract exist.",
      tag: "demo",
      response: z.object({
        demoMode: z.boolean(),
        projectId: z.string().nullable(),
        agentId: z.string().nullable(),
        baselineCount: z.number(),
        contractCount: z.number(),
        activeContractId: z.string().nullable(),
        activeContractHash: z.string().nullable(),
        checkedAt: IsoDate,
      }),
      errors: [],
    },
    async () => {
      const project = await findProjectBySlug(sql, DEMO_PROJECT_SLUG);
      if (!project) {
        return {
          demoMode: config.demoMode,
          projectId: null,
          agentId: null,
          baselineCount: 0,
          contractCount: 0,
          activeContractId: null,
          activeContractHash: null,
          checkedAt: context.now().toISOString(),
        };
      }
      const agent = await findAgentByKey(sql, project.id, DEMO_AGENT_KEY);
      if (!agent) {
        return {
          demoMode: config.demoMode,
          projectId: project.id,
          agentId: null,
          baselineCount: 0,
          contractCount: 0,
          activeContractId: null,
          activeContractHash: null,
          checkedAt: context.now().toISOString(),
        };
      }
      const page = toPageRequest({ limit: 100 });
      const baselines = await listBaselines(sql, agent.id, page);
      const contracts = await listContracts(sql, agent.id, page);
      const active = await findActiveContract(sql, agent.id, project.defaultEnvironment);
      return {
        demoMode: config.demoMode,
        projectId: project.id,
        agentId: agent.id,
        baselineCount: baselines.items.length,
        contractCount: contracts.items.length,
        activeContractId: active?.id ?? null,
        activeContractHash: active?.contentHash ?? null,
        checkedAt: context.now().toISOString(),
      };
    },
  );
}
