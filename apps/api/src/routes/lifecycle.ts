import { createHash } from "node:crypto";
import {
  resolveSelection as resolveSelectionOf,
  selectionHash as selectionHashOf,
} from "@flightrules/baseline-miner";
import { EVALUATOR_VERSION } from "@flightrules/contract-engine";
import {
  canonicalContract,
  contractContentHash,
  parseContract,
} from "@flightrules/contract-schema";
import type { Db } from "@flightrules/db";
import {
  activateContract,
  approveBaseline,
  approveContract,
  type ContractStatus,
  canTransition,
  createContract,
  createEvaluation,
  decideRouteFamily,
  findAgent,
  findBaseline,
  findContract,
  findEvaluation,
  findProject,
  findRelease,
  findRouteFamily,
  findViolation,
  listBaselines,
  listContractRules,
  listContracts,
  listProjectViolations,
  listReleases,
  listRunEvaluations,
  markContractInvalid,
  markContractValid,
  observeRelease,
  recordAudit,
  replaceDraft,
  submitJob,
  toPageRequest,
} from "@flightrules/db";
import { FlightRulesError } from "@flightrules/domain";
import { DEFAULT_NORMALISER_CONFIG, identityOf } from "@flightrules/normaliser";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { invalidTransition, notFound, requireUuid } from "../http.js";
import type { RouteRegistry } from "../registry.js";
import { jobDto } from "./core.js";

/**
 * Baselines, contracts, evaluations, violations and the demo (PRD sections 15.5 to 15.9, FR-007,
 * FR-010, FR-017, FR-018, FR-019, FR-020).
 *
 * Everything long-running becomes a job (PRD section 15.5: "Long-running endpoints return a job
 * ID"). The API never mines, never evaluates and never talks to SigNoz for those operations; it
 * validates, writes one row, and hands back an identifier. That is what makes a repeated request
 * cheap and a restart harmless.
 */

const PageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().min(1).max(200).optional(),
});

const IsoDate = z.string();
const iso = (value: Date | null): string | null => (value === null ? null : value.toISOString());

const JobAcceptedResponse = z.object({
  jobId: z.string(),
  status: z.string(),
  created: z.boolean(),
  idempotencyKey: z.string(),
  job: z.unknown(),
});

const RouteFamilyResponse = z.object({
  id: z.string(),
  familyIdentifier: z.string(),
  fingerprint: z.string(),
  status: z.string(),
  rare: z.boolean(),
  occurrenceCount: z.number(),
  occurrencePercent: z.string(),
  representativeTraceIds: z.array(z.string()),
  statistics: z.unknown(),
  canonicalGraph: z.unknown(),
  decidedAt: IsoDate.nullable(),
});

const BaselineResponse = z.object({
  id: z.string(),
  agentId: z.string(),
  baselineIdentifier: z.string(),
  selectionHash: z.string(),
  status: z.string(),
  environment: z.string().nullable(),
  sourceTimeStart: IsoDate,
  sourceTimeEnd: IsoDate,
  minimumRuns: z.number(),
  normaliserVersion: z.string(),
  normaliserConfigHash: z.string(),
  counts: z.unknown(),
  retrieval: z.unknown(),
  excluded: z.unknown(),
  disclosures: z.unknown(),
  jobId: z.string().nullable(),
  approvedAt: IsoDate.nullable(),
  createdAt: IsoDate,
  families: z.array(RouteFamilyResponse),
});

const ContractResponse = z.object({
  id: z.string(),
  agentId: z.string(),
  baselineVersionId: z.string().nullable(),
  name: z.string(),
  contractKey: z.string(),
  semanticVersion: z.string(),
  schemaVersion: z.string(),
  environment: z.string(),
  status: z.string(),
  source: z.string(),
  contentHash: z.string(),
  validationErrors: z.unknown(),
  approvedAt: IsoDate.nullable(),
  activatedAt: IsoDate.nullable(),
  supersededAt: IsoDate.nullable(),
  supersededByContractId: z.string().nullable(),
  createdAt: IsoDate,
  updatedAt: IsoDate,
  ruleCount: z.number().optional(),
});

const ViolationResponse = z.object({
  id: z.string(),
  runEvaluationId: z.string(),
  violationKey: z.string(),
  ruleKey: z.string(),
  ruleType: z.string(),
  violationType: z.string(),
  severity: z.string(),
  zeroTolerance: z.boolean(),
  message: z.string(),
  expected: z.string(),
  observed: z.string(),
  signozWebUrl: z.string().nullable(),
  traceId: z.string(),
  releaseKey: z.string().nullable(),
  contractId: z.string(),
  contractVersion: z.string(),
  createdAt: IsoDate,
});

function page<T extends z.ZodType>(item: T) {
  return z.object({ items: z.array(item), nextCursor: z.string().nullable() });
}

function familyDto(family: NonNullable<Awaited<ReturnType<typeof findRouteFamily>>>) {
  return {
    id: family.id,
    familyIdentifier: family.familyIdentifier,
    fingerprint: family.fingerprint,
    status: family.status,
    rare: family.rare,
    occurrenceCount: family.occurrenceCount,
    occurrencePercent: family.occurrencePercent.decimal,
    representativeTraceIds: [...family.representativeTraceIds],
    statistics: family.statistics,
    canonicalGraph: family.canonical,
    decidedAt: iso(family.decidedAt),
  };
}

function baselineDto(baseline: NonNullable<Awaited<ReturnType<typeof findBaseline>>>) {
  return {
    id: baseline.id,
    agentId: baseline.agentId,
    baselineIdentifier: baseline.baselineIdentifier,
    selectionHash: baseline.selectionHash,
    status: baseline.status,
    environment: baseline.environment,
    sourceTimeStart: baseline.sourceTimeStart.toISOString(),
    sourceTimeEnd: baseline.sourceTimeEnd.toISOString(),
    minimumRuns: baseline.minimumRuns,
    normaliserVersion: baseline.normaliserVersion,
    normaliserConfigHash: baseline.normaliserConfigHash,
    counts: baseline.counts,
    retrieval: baseline.retrieval,
    excluded: baseline.excluded,
    disclosures: baseline.disclosures,
    jobId: baseline.jobId,
    approvedAt: iso(baseline.approvedAt),
    createdAt: baseline.createdAt.toISOString(),
    families: baseline.families.map(familyDto),
  };
}

function contractDto(contract: NonNullable<Awaited<ReturnType<typeof findContract>>>) {
  return {
    id: contract.id,
    agentId: contract.agentId,
    baselineVersionId: contract.baselineVersionId,
    name: contract.name,
    contractKey: contract.contractKey,
    semanticVersion: contract.semanticVersion,
    schemaVersion: contract.schemaVersion,
    environment: contract.environment,
    status: contract.status,
    source: contract.source,
    contentHash: contract.contentHash,
    validationErrors: contract.validationErrors,
    approvedAt: iso(contract.approvedAt),
    activatedAt: iso(contract.activatedAt),
    supersededAt: iso(contract.supersededAt),
    supersededByContractId: contract.supersededByContractId,
    createdAt: contract.createdAt.toISOString(),
    updatedAt: contract.updatedAt.toISOString(),
  };
}

/** A deterministic idempotency key for work whose identity is not already a content hash. */
function keyOf(parts: readonly (string | number | boolean | null)[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

export function registerLifecycleRoutes(
  server: FastifyInstance,
  registry: RouteRegistry,
  context: AppContext,
): void {
  const { sql, config } = context;
  const normaliser = identityOf(DEFAULT_NORMALISER_CONFIG);

  // -------------------------------------------------------------------------
  // 15.5 Baselines (FR-007)
  // -------------------------------------------------------------------------

  registry.add(
    server,
    {
      method: "POST",
      url: "/api/agents/:agentId/baselines",
      summary:
        "Requests a baseline capture. Returns a job; idempotent on the miner's selection hash.",
      tag: "baselines",
      body: z.object({
        releaseKey: z.string().min(1).max(200),
        environment: z.string().min(1).max(120).nullable().optional(),
        startMs: z.number().int().nonnegative(),
        endMs: z.number().int().nonnegative(),
        minimumRuns: z.number().int().min(1).max(5_000),
        rootSpanName: z.string().min(1).max(200),
        successfulRunsOnly: z.boolean().optional(),
        excludeMissingRootSpan: z.boolean().optional(),
        rareThreshold: z.number().min(0).max(1).optional(),
        maxTraces: z.number().int().min(1).max(5_000).optional(),
        representativesPerFamily: z.number().int().min(1).max(50).optional(),
      }),
      response: JobAcceptedResponse,
      successStatus: 202,
      errors: ["JOB_ALREADY_RUNNING", "VALIDATION_FAILED"],
    },
    async ({ params, body }) => {
      const agentId = requireUuid(params["agentId"] ?? "", "agent");
      const agent = await findAgent(sql, agentId);
      if (!agent) throw notFound("agent", agentId);
      const project = await findProject(sql, agent.projectId);
      if (!project) throw notFound("project", agent.projectId);
      if (body.endMs <= body.startMs) {
        throw new FlightRulesError("VALIDATION_FAILED", {
          message: "A mining window must end after it starts.",
          details: { field: "endMs" },
        });
      }

      const selection = {
        projectKey: project.slug,
        agentKey: agent.agentKey,
        releaseId: body.releaseKey,
        environment: body.environment ?? null,
        startMs: body.startMs,
        endMs: body.endMs,
        minimumRuns: body.minimumRuns,
        rootSpanName: body.rootSpanName,
        successfulRunsOnly: body.successfulRunsOnly ?? true,
        excludeMissingRootSpan: body.excludeMissingRootSpan ?? true,
        rareThreshold: body.rareThreshold ?? 0.05,
        maxTraces: Math.min(body.maxTraces ?? 1_000, config.maxTracesPerEvaluation * 10),
        representativesPerFamily: body.representativesPerFamily ?? 3,
        maxSpansPerTrace: config.maxSpansPerTrace,
      };

      // PRD sections 18.2 and 20.1: the miner's own selection hash is the key, so two identical
      // requests are one job and one baseline rather than two of each.
      const idempotencyKey = miningSelectionHash(selection);

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
            ...selection,
            releaseKey: selection.releaseId,
          },
        });
        if (result.created) {
          await recordAudit(tx, {
            projectId: project.id,
            actorType: "user",
            eventType: "baseline.requested",
            entityType: "agent",
            entityId: agent.id,
            details: { jobId: result.job.id, releaseKey: body.releaseKey },
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
      method: "GET",
      url: "/api/agents/:agentId/baselines",
      summary: "Baselines for an agent, newest first.",
      tag: "baselines",
      query: PageQuery,
      response: page(
        z.object({
          id: z.string(),
          agentId: z.string(),
          status: z.string(),
          baselineIdentifier: z.string(),
          selectionHash: z.string(),
          sourceTimeStart: IsoDate,
          sourceTimeEnd: IsoDate,
          familyCount: z.number(),
          approvedAt: IsoDate.nullable(),
          createdAt: IsoDate,
        }),
      ),
      errors: [],
    },
    async ({ params, query }) => {
      const agentId = requireUuid(params["agentId"] ?? "", "agent");
      if (!(await findAgent(sql, agentId))) throw notFound("agent", agentId);
      const result = await listBaselines(sql, agentId, toPageRequest(query));
      return {
        items: result.items.map((item) => ({
          id: item.id,
          agentId: item.agentId,
          status: item.status,
          baselineIdentifier: item.baselineIdentifier,
          selectionHash: item.selectionHash,
          sourceTimeStart: item.sourceTimeStart.toISOString(),
          sourceTimeEnd: item.sourceTimeEnd.toISOString(),
          familyCount: item.familyCount,
          approvedAt: iso(item.approvedAt),
          createdAt: item.createdAt.toISOString(),
        })),
        nextCursor: result.nextCursor,
      };
    },
  );

  registry.add(
    server,
    {
      method: "GET",
      url: "/api/baselines/:baselineId",
      summary: "A baseline with every mined route family and every disclosure.",
      tag: "baselines",
      response: BaselineResponse,
      errors: [],
    },
    async ({ params }) => {
      const id = requireUuid(params["baselineId"] ?? "", "baseline");
      const baseline = await findBaseline(sql, id);
      if (!baseline) throw notFound("baseline", id);
      return baselineDto(baseline);
    },
  );

  const decide = async (
    baselineId: string,
    familyId: string,
    status: "approved" | "rejected" | "optional" | "excluded_fixture_error",
    eventType:
      | "route_family.approved"
      | "route_family.excluded"
      | "route_family.rejected"
      | "route_family.marked_optional",
  ) => {
    const baseline = await findBaseline(sql, baselineId);
    if (!baseline) throw notFound("baseline", baselineId);
    // ADR-0007 decisions 11 and 12: a truncated or under-populated dataset may not be reviewed.
    if (baseline.status === "dataset_truncated" || baseline.status === "insufficient_runs") {
      throw new FlightRulesError("BASELINE_INSUFFICIENT_RUNS", {
        message: `This baseline cannot be reviewed because it is ${baseline.status}.`,
        details: { baselineId, status: baseline.status },
      });
    }
    const existing = await findRouteFamily(sql, baselineId, familyId);
    if (!existing) throw notFound("route family", familyId);

    const agent = await findAgent(sql, baseline.agentId);
    const decided = await sql.begin(async (tx) => {
      const family = await decideRouteFamily(tx, familyId, status);
      if (!family) return null;
      await recordAudit(tx, {
        projectId: agent?.projectId ?? null,
        actorType: "user",
        eventType,
        entityType: "route_family",
        entityId: family.id,
        details: { baselineId, fingerprint: family.fingerprint, status },
      });
      if (status === "approved") await approveBaseline(tx, baselineId);
      return family;
    });
    if (!decided) throw notFound("route family", familyId);
    const refreshed = await findBaseline(sql, baselineId);
    if (!refreshed) throw notFound("baseline", baselineId);
    return { family: familyDto(decided), baselineStatus: refreshed.status };
  };

  const decisionResponse = z.object({
    family: RouteFamilyResponse,
    baselineStatus: z.string(),
  });

  registry.add(
    server,
    {
      method: "POST",
      url: "/api/baselines/:baselineId/route-families/:familyId/approve",
      summary: "PRD section 8.8's approve action. Approving a family approves the baseline.",
      tag: "baselines",
      body: z.object({ markOptional: z.boolean().optional() }),
      response: decisionResponse,
      errors: ["BASELINE_INSUFFICIENT_RUNS"],
    },
    async ({ params, body }) => {
      const baselineId = requireUuid(params["baselineId"] ?? "", "baseline");
      const familyId = requireUuid(params["familyId"] ?? "", "route family");
      return body.markOptional === true
        ? decide(baselineId, familyId, "optional", "route_family.marked_optional")
        : decide(baselineId, familyId, "approved", "route_family.approved");
    },
  );

  registry.add(
    server,
    {
      method: "POST",
      url: "/api/baselines/:baselineId/route-families/:familyId/exclude",
      summary:
        "PRD section 8.8's exclude and reject actions. `asFixtureError` distinguishes the two.",
      tag: "baselines",
      body: z.object({ asFixtureError: z.boolean().optional() }),
      response: decisionResponse,
      errors: ["BASELINE_INSUFFICIENT_RUNS"],
    },
    async ({ params, body }) => {
      const baselineId = requireUuid(params["baselineId"] ?? "", "baseline");
      const familyId = requireUuid(params["familyId"] ?? "", "route family");
      return body.asFixtureError === true
        ? decide(baselineId, familyId, "excluded_fixture_error", "route_family.excluded")
        : decide(baselineId, familyId, "rejected", "route_family.rejected");
    },
  );

  registry.add(
    server,
    {
      method: "POST",
      url: "/api/baselines/:baselineId/propose-contract",
      summary:
        "Requests a contract proposal from the reviewed baseline. Returns a job. Nothing is activated.",
      tag: "baselines",
      body: z.object({
        contractName: z.string().trim().min(1).max(200).optional(),
        semanticVersion: z
          .string()
          .regex(/^[0-9]+\.[0-9]+\.[0-9]+$/)
          .optional(),
        workflowName: z.string().min(1).max(200),
        environment: z.string().min(1).max(120).optional(),
        createdAt: z.string().min(1).max(40).optional(),
      }),
      response: JobAcceptedResponse,
      successStatus: 202,
      errors: ["BASELINE_INSUFFICIENT_RUNS", "JOB_ALREADY_RUNNING"],
    },
    async ({ params, body }) => {
      const baselineId = requireUuid(params["baselineId"] ?? "", "baseline");
      const baseline = await findBaseline(sql, baselineId);
      if (!baseline) throw notFound("baseline", baselineId);
      if (baseline.status !== "approved") {
        throw new FlightRulesError("BASELINE_INSUFFICIENT_RUNS", {
          message:
            "A contract can only be proposed from an approved baseline. Approve at least one route family first.",
          details: { baselineId, status: baseline.status },
        });
      }
      const agent = await findAgent(sql, baseline.agentId);
      if (!agent) throw notFound("agent", baseline.agentId);
      const project = await findProject(sql, agent.projectId);
      if (!project) throw notFound("project", agent.projectId);

      const decisions = baseline.families
        .filter((family) => family.status !== "pending")
        .map((family) => ({
          fingerprint: family.fingerprint,
          status: family.status as "approved" | "rejected" | "optional" | "excluded_fixture_error",
        }))
        .sort((a, b) => (a.fingerprint < b.fingerprint ? -1 : 1));

      const input = {
        baselineVersionId: baseline.id,
        agentId: agent.id,
        projectId: project.id,
        environment: body.environment ?? project.defaultEnvironment,
        workflowName: body.workflowName,
        // Supplied rather than read from a clock, so the proposal is byte-reproducible.
        createdAt: body.createdAt ?? context.now().toISOString(),
        contractName: body.contractName ?? `${agent.name} trajectory contract`,
        semanticVersion: body.semanticVersion ?? "1.0.0",
        decisions,
      };
      const idempotencyKey = keyOf([
        baseline.id,
        input.environment,
        input.workflowName,
        input.createdAt,
        input.semanticVersion,
        ...decisions.map((decision) => `${decision.fingerprint}:${decision.status}`),
      ]);

      const submitted = await sql.begin(async (tx) => {
        const result = await submitJob(tx, {
          jobType: "contract_proposal",
          entityType: "baseline_version",
          entityId: baseline.id,
          projectId: project.id,
          idempotencyKey,
          input,
        });
        if (result.created) {
          await recordAudit(tx, {
            projectId: project.id,
            actorType: "user",
            eventType: "contract.proposal.requested",
            entityType: "baseline_version",
            entityId: baseline.id,
            details: { jobId: result.job.id },
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

  // -------------------------------------------------------------------------
  // 15.6 Contracts (FR-018)
  // -------------------------------------------------------------------------

  registry.add(
    server,
    {
      method: "GET",
      url: "/api/agents/:agentId/contracts",
      summary: "Contracts for an agent, newest first.",
      tag: "contracts",
      query: PageQuery,
      response: page(ContractResponse),
      errors: [],
    },
    async ({ params, query }) => {
      const agentId = requireUuid(params["agentId"] ?? "", "agent");
      if (!(await findAgent(sql, agentId))) throw notFound("agent", agentId);
      const result = await listContracts(sql, agentId, toPageRequest(query));
      return { items: result.items.map(contractDto), nextCursor: result.nextCursor };
    },
  );

  const contractBody = z.object({
    yaml: z.string().min(1).max(1_000_000),
    environment: z.string().min(1).max(120).optional(),
  });

  registry.add(
    server,
    {
      method: "POST",
      url: "/api/agents/:agentId/contracts",
      summary: "Creates a draft contract from a YAML document, validated by the Phase 07 parser.",
      tag: "contracts",
      body: contractBody,
      response: ContractResponse,
      successStatus: 201,
      errors: ["CONTRACT_INVALID", "CONTRACT_CONFLICT"],
    },
    async ({ params, body }) => {
      const agentId = requireUuid(params["agentId"] ?? "", "agent");
      const agent = await findAgent(sql, agentId);
      if (!agent) throw notFound("agent", agentId);
      const project = await findProject(sql, agent.projectId);
      if (!project) throw notFound("project", agent.projectId);

      const parsed = parseContract(body.yaml);
      if (!parsed.ok) {
        throw new FlightRulesError("CONTRACT_INVALID", {
          details: { errors: parsed.errors.map((error) => ({ ...error })) },
        });
      }

      const created = await sql
        .begin(async (tx) => {
          const result = await createContract(tx, {
            agentId,
            baselineVersionId: null,
            jobId: null,
            environment: body.environment ?? project.defaultEnvironment,
            source: "authored",
            contract: parsed.value.contract,
            canonical: canonicalContract(parsed.value.contract),
            contentHash: parsed.value.contentHash,
            yamlText: body.yaml,
          });
          await recordAudit(tx, {
            projectId: project.id,
            actorType: "user",
            eventType: "contract.created",
            entityType: "contract",
            entityId: result.contract.id,
            details: { contentHash: result.contract.contentHash, source: "authored" },
          });
          return result.contract;
        })
        .catch((error: unknown) => {
          if (
            typeof error === "object" &&
            error !== null &&
            (error as { code?: string }).code === "23505"
          ) {
            throw new FlightRulesError("CONTRACT_CONFLICT", {
              message:
                "A contract with that identifier, version and environment already exists for this agent.",
            });
          }
          throw error;
        });
      return contractDto(created);
    },
  );

  registry.add(
    server,
    {
      method: "GET",
      url: "/api/contracts/:contractId",
      summary: "A contract with its rule projection, including each rule's evidence basis.",
      tag: "contracts",
      response: ContractResponse.extend({
        rules: z.array(
          z.object({
            ruleKey: z.string(),
            ruleType: z.string(),
            severity: z.string(),
            zeroTolerance: z.boolean(),
            rule: z.unknown(),
            evidenceBasis: z.unknown(),
          }),
        ),
      }),
      errors: [],
    },
    async ({ params }) => {
      const id = requireUuid(params["contractId"] ?? "", "contract");
      const contract = await findContract(sql, id);
      if (!contract) throw notFound("contract", id);
      const rules = await listContractRules(sql, id);
      return {
        ...contractDto(contract),
        ruleCount: rules.length,
        rules: rules.map((rule) => ({
          ruleKey: rule.ruleKey,
          ruleType: rule.ruleType,
          severity: rule.severity,
          zeroTolerance: rule.zeroTolerance,
          rule: rule.rule,
          evidenceBasis: rule.evidenceBasis ?? null,
        })),
      };
    },
  );

  registry.add(
    server,
    {
      method: "PUT",
      url: "/api/contracts/:contractId",
      summary:
        "Replaces a draft contract. An approved, active or superseded contract is immutable.",
      tag: "contracts",
      body: contractBody,
      response: ContractResponse,
      errors: ["CONTRACT_INVALID", "STATE_TRANSITION_INVALID"],
    },
    async ({ params, body }) => {
      const id = requireUuid(params["contractId"] ?? "", "contract");
      const existing = await findContract(sql, id);
      if (!existing) throw notFound("contract", id);
      if (existing.status !== "draft") {
        throw invalidTransition("contract", existing.status, "draft");
      }
      const parsed = parseContract(body.yaml);
      if (!parsed.ok) {
        throw new FlightRulesError("CONTRACT_INVALID", {
          details: { errors: parsed.errors.map((error) => ({ ...error })) },
        });
      }
      const agent = await findAgent(sql, existing.agentId);
      const updated = await sql.begin(async (tx) => {
        const result = await replaceDraft(tx, {
          contractId: id,
          contract: parsed.value.contract,
          canonical: canonicalContract(parsed.value.contract),
          contentHash: parsed.value.contentHash,
          yamlText: body.yaml,
        });
        if (!result) return null;
        await recordAudit(tx, {
          projectId: agent?.projectId ?? null,
          actorType: "user",
          eventType: "contract.updated",
          entityType: "contract",
          entityId: id,
          details: { contentHash: result.contract.contentHash },
        });
        return result.contract;
      });
      if (!updated) throw invalidTransition("contract", existing.status, "draft");
      return contractDto(updated);
    },
  );

  registry.add(
    server,
    {
      method: "POST",
      url: "/api/contracts/:contractId/validate",
      summary:
        "Revalidates the stored document. A failure moves the contract to `invalid` (FR-018).",
      tag: "contracts",
      body: z.object({}).optional(),
      response: z.object({
        valid: z.boolean(),
        status: z.string(),
        contentHash: z.string(),
        contentHashStable: z.boolean(),
        errors: z.array(z.unknown()),
      }),
      errors: [],
    },
    async ({ params }) => {
      const id = requireUuid(params["contractId"] ?? "", "contract");
      const contract = await findContract(sql, id);
      if (!contract) throw notFound("contract", id);
      const agent = await findAgent(sql, contract.agentId);

      const parsed = parseContract(contract.yamlText);
      if (!parsed.ok) {
        const errors = parsed.errors.map((error) => ({ ...error }));
        const updated = await sql.begin(async (tx) => {
          const marked = await markContractInvalid(tx, id, errors);
          await recordAudit(tx, {
            projectId: agent?.projectId ?? null,
            actorType: "user",
            eventType: "contract.validated",
            entityType: "contract",
            entityId: id,
            details: { valid: false, errorCount: errors.length },
          });
          return marked;
        });
        return {
          valid: false,
          status: updated?.status ?? contract.status,
          contentHash: contract.contentHash,
          contentHashStable: false,
          errors,
        };
      }

      // The document is re-hashed from its own text, so a stored hash that no longer describes the
      // stored YAML is reported rather than trusted.
      const rehashed = contractContentHash(parsed.value.contract);
      const recovered =
        contract.status === "invalid"
          ? await sql.begin(async (tx) => {
              const marked = await markContractValid(tx, id);
              await recordAudit(tx, {
                projectId: agent?.projectId ?? null,
                actorType: "user",
                eventType: "contract.validated",
                entityType: "contract",
                entityId: id,
                details: { valid: true },
              });
              return marked;
            })
          : null;

      return {
        valid: true,
        status: recovered?.status ?? contract.status,
        contentHash: rehashed,
        contentHashStable: rehashed === contract.contentHash,
        errors: [],
      };
    },
  );

  const transition = async (
    contractId: string,
    to: ContractStatus,
    action: (tx: Db) => Promise<unknown>,
  ) => {
    const contract = await findContract(sql, contractId);
    if (!contract) throw notFound("contract", contractId);
    if (!canTransition(contract.status, to)) {
      throw invalidTransition("contract", contract.status, to);
    }
    await sql.begin(action);
    const refreshed = await findContract(sql, contractId);
    if (!refreshed) throw notFound("contract", contractId);
    return refreshed;
  };

  registry.add(
    server,
    {
      method: "POST",
      url: "/api/contracts/:contractId/approve",
      summary: "FR-018 `draft -> approved`. An invalid contract cannot be approved.",
      tag: "contracts",
      body: z.object({}).optional(),
      response: ContractResponse,
      errors: ["STATE_TRANSITION_INVALID"],
    },
    async ({ params }) => {
      const id = requireUuid(params["contractId"] ?? "", "contract");
      const contract = await findContract(sql, id);
      if (!contract) throw notFound("contract", id);
      const agent = await findAgent(sql, contract.agentId);
      const updated = await transition(id, "approved", async (tx) => {
        const approved = await approveContract(tx, id);
        if (!approved) throw invalidTransition("contract", contract.status, "approved");
        await recordAudit(tx, {
          projectId: agent?.projectId ?? null,
          actorType: "user",
          eventType: "contract.approved",
          entityType: "contract",
          entityId: id,
          details: { contentHash: approved.contentHash },
        });
      });
      return contractDto(updated);
    },
  );

  registry.add(
    server,
    {
      method: "POST",
      url: "/api/contracts/:contractId/activate",
      summary:
        "FR-018 `approved -> active`. Supersedes the prior active contract for the same agent and environment.",
      tag: "contracts",
      body: z.object({}).optional(),
      response: ContractResponse.extend({ supersededContractId: z.string().nullable() }),
      errors: ["STATE_TRANSITION_INVALID", "CONTRACT_CONFLICT"],
    },
    async ({ params }) => {
      const id = requireUuid(params["contractId"] ?? "", "contract");
      const contract = await findContract(sql, id);
      if (!contract) throw notFound("contract", id);
      if (!canTransition(contract.status, "active")) {
        throw invalidTransition("contract", contract.status, "active");
      }
      const agent = await findAgent(sql, contract.agentId);

      const result = await sql.begin(async (tx) => {
        const activation = await activateContract(tx, id);
        if (!activation) throw notFound("contract", id);
        await recordAudit(tx, {
          projectId: agent?.projectId ?? null,
          actorType: "user",
          eventType: "contract.activated",
          entityType: "contract",
          entityId: id,
          details: {
            environment: activation.activated.environment,
            supersededContractId: activation.superseded?.id ?? null,
          },
        });
        if (activation.superseded) {
          await recordAudit(tx, {
            projectId: agent?.projectId ?? null,
            actorType: "system",
            eventType: "contract.superseded",
            entityType: "contract",
            entityId: activation.superseded.id,
            details: { supersededBy: id },
          });
        }
        return activation;
      });

      return {
        ...contractDto(result.activated),
        supersededContractId: result.superseded?.id ?? null,
      };
    },
  );

  registry.add(
    server,
    {
      method: "GET",
      url: "/api/contracts/:contractId/export",
      summary: "The stored YAML document, exactly as validated.",
      tag: "contracts",
      response: z.object({
        contractId: z.string(),
        contentHash: z.string(),
        yaml: z.string(),
      }),
      errors: [],
    },
    async ({ params }) => {
      const id = requireUuid(params["contractId"] ?? "", "contract");
      const contract = await findContract(sql, id);
      if (!contract) throw notFound("contract", id);
      return {
        contractId: contract.id,
        contentHash: contract.contentHash,
        yaml: contract.yamlText,
      };
    },
  );

  // -------------------------------------------------------------------------
  // 15.7 Evaluations and releases (FR-010)
  // -------------------------------------------------------------------------

  const submitEvaluation = async (input: {
    agentId: string;
    contractId: string;
    releaseKey: string;
    environment?: string | undefined;
    scope: "run" | "release";
    rootSpanName: string;
    startMs: number;
    endMs: number;
    maxTraces?: number | undefined;
  }) => {
    const agent = await findAgent(sql, input.agentId);
    if (!agent) throw notFound("agent", input.agentId);
    const project = await findProject(sql, agent.projectId);
    if (!project) throw notFound("project", agent.projectId);
    const contract = await findContract(sql, input.contractId);
    if (!contract) throw notFound("contract", input.contractId);
    if (contract.status !== "active" && contract.status !== "approved") {
      throw new FlightRulesError("CONTRACT_CONFLICT", {
        message: "Only an approved or active contract can be evaluated against.",
        details: { contractId: contract.id, status: contract.status },
      });
    }

    const environment = input.environment ?? contract.environment;
    const release = await sql.begin((tx) =>
      observeRelease(tx, {
        agentId: agent.id,
        releaseKey: input.releaseKey,
        environment,
        observedAt: new Date(input.endMs),
      }),
    );

    const idempotencyKey = keyOf([
      contract.id,
      contract.contentHash,
      release.id,
      input.scope,
      input.startMs,
      input.endMs,
      input.rootSpanName,
    ]);

    return sql.begin(async (tx) => {
      const created = await createEvaluation(tx, {
        agentId: agent.id,
        contractId: contract.id,
        releaseId: release.id,
        scope: input.scope,
        evaluatorVersion: EVALUATOR_VERSION,
        normaliserVersion: normaliser.version,
        normaliserConfigHash: normaliser.configHash,
        contractContentHash: contract.contentHash,
        idempotencyKey,
        windowStart: new Date(input.startMs),
        windowEnd: new Date(input.endMs),
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
          releaseKey: input.releaseKey,
          environment,
          scope: input.scope,
          rootSpanName: input.rootSpanName,
          startMs: input.startMs,
          endMs: input.endMs,
          maxTraces: Math.min(
            input.maxTraces ?? config.maxTracesPerEvaluation,
            config.maxTracesPerEvaluation,
          ),
          maxSpansPerTrace: config.maxSpansPerTrace,
        },
      });

      if (submitted.created) {
        await recordAudit(tx, {
          projectId: project.id,
          actorType: "user",
          eventType: "evaluation.requested",
          entityType: "evaluation",
          entityId: created.evaluation.id,
          details: { jobId: submitted.job.id, releaseKey: input.releaseKey, scope: input.scope },
        });
      }

      return { submitted, evaluationId: created.evaluation.id, idempotencyKey };
    });
  };

  const EvaluationRequest = z.object({
    contractId: z.string(),
    releaseKey: z.string().min(1).max(200),
    environment: z.string().min(1).max(120).optional(),
    scope: z.enum(["run", "release"]).optional(),
    rootSpanName: z.string().min(1).max(200),
    startMs: z.number().int().nonnegative(),
    endMs: z.number().int().nonnegative(),
    maxTraces: z.number().int().min(1).max(5_000).optional(),
  });

  registry.add(
    server,
    {
      method: "POST",
      url: "/api/agents/:agentId/evaluations",
      summary: "Requests an evaluation of a release against a contract. Returns a job.",
      tag: "evaluations",
      body: EvaluationRequest,
      response: JobAcceptedResponse.extend({ evaluationId: z.string() }),
      successStatus: 202,
      errors: ["CONTRACT_CONFLICT", "JOB_ALREADY_RUNNING"],
    },
    async ({ params, body }) => {
      const agentId = requireUuid(params["agentId"] ?? "", "agent");
      const contractId = requireUuid(body.contractId, "contract");
      const result = await submitEvaluation({
        agentId,
        contractId,
        releaseKey: body.releaseKey,
        environment: body.environment,
        scope: body.scope ?? "release",
        rootSpanName: body.rootSpanName,
        startMs: body.startMs,
        endMs: body.endMs,
        maxTraces: body.maxTraces,
      });
      return {
        jobId: result.submitted.job.id,
        status: result.submitted.job.status,
        created: result.submitted.created,
        idempotencyKey: result.idempotencyKey,
        evaluationId: result.evaluationId,
        job: jobDto(result.submitted.job),
      };
    },
  );

  registry.add(
    server,
    {
      method: "GET",
      url: "/api/evaluations/:evaluationId",
      summary: "An evaluation with every per-run result.",
      tag: "evaluations",
      response: z.object({
        id: z.string(),
        agentId: z.string(),
        contractId: z.string(),
        releaseId: z.string().nullable(),
        scope: z.string(),
        status: z.string(),
        evaluatorVersion: z.string(),
        normaliserVersion: z.string(),
        contractContentHash: z.string(),
        summary: z.unknown(),
        startedAt: IsoDate.nullable(),
        completedAt: IsoDate.nullable(),
        createdAt: IsoDate,
        runs: z.array(
          z.object({
            id: z.string(),
            traceRunId: z.string(),
            status: z.string(),
            routeFingerprint: z.string(),
            routeApproved: z.boolean(),
            similarity: z.string(),
            evaluationHash: z.string(),
            result: z.unknown(),
          }),
        ),
      }),
      errors: [],
    },
    async ({ params }) => {
      const id = requireUuid(params["evaluationId"] ?? "", "evaluation");
      const evaluation = await findEvaluation(sql, id);
      if (!evaluation) throw notFound("evaluation", id);
      const runs = await listRunEvaluations(sql, id);
      return {
        id: evaluation.id,
        agentId: evaluation.agentId,
        contractId: evaluation.contractId,
        releaseId: evaluation.releaseId,
        scope: evaluation.scope,
        status: evaluation.status,
        evaluatorVersion: evaluation.evaluatorVersion,
        normaliserVersion: evaluation.normaliserVersion,
        contractContentHash: evaluation.contractContentHash,
        summary: evaluation.summary,
        startedAt: iso(evaluation.startedAt),
        completedAt: iso(evaluation.completedAt),
        createdAt: evaluation.createdAt.toISOString(),
        runs: runs.map((run) => ({
          id: run.id,
          traceRunId: run.traceRunId,
          status: run.status,
          routeFingerprint: run.routeFingerprint,
          routeApproved: run.routeApproved,
          similarity: run.similarity.decimal,
          evaluationHash: run.evaluationHash,
          result: run.result,
        })),
      };
    },
  );

  const ReleaseResponse = z.object({
    id: z.string(),
    agentId: z.string(),
    releaseKey: z.string(),
    environment: z.string(),
    commitSha: z.string().nullable(),
    imageDigest: z.string().nullable(),
    firstObservedAt: IsoDate.nullable(),
    lastObservedAt: IsoDate.nullable(),
    createdAt: IsoDate,
  });

  const releaseDto = (release: NonNullable<Awaited<ReturnType<typeof findRelease>>>) => ({
    id: release.id,
    agentId: release.agentId,
    releaseKey: release.releaseKey,
    environment: release.environment,
    commitSha: release.commitSha,
    imageDigest: release.imageDigest,
    firstObservedAt: iso(release.firstObservedAt),
    lastObservedAt: iso(release.lastObservedAt),
    createdAt: release.createdAt.toISOString(),
  });

  registry.add(
    server,
    {
      method: "GET",
      url: "/api/agents/:agentId/releases",
      summary: "Releases observed for an agent.",
      tag: "releases",
      query: PageQuery,
      response: page(ReleaseResponse),
      errors: [],
    },
    async ({ params, query }) => {
      const agentId = requireUuid(params["agentId"] ?? "", "agent");
      if (!(await findAgent(sql, agentId))) throw notFound("agent", agentId);
      const result = await listReleases(sql, agentId, toPageRequest(query));
      return { items: result.items.map(releaseDto), nextCursor: result.nextCursor };
    },
  );

  registry.add(
    server,
    {
      method: "GET",
      url: "/api/releases/:releaseId",
      summary: "One release.",
      tag: "releases",
      response: ReleaseResponse,
      errors: [],
    },
    async ({ params }) => {
      const id = requireUuid(params["releaseId"] ?? "", "release");
      const release = await findRelease(sql, id);
      if (!release) throw notFound("release", id);
      return releaseDto(release);
    },
  );

  registry.add(
    server,
    {
      method: "POST",
      url: "/api/releases/:releaseId/re-evaluate",
      summary: "Re-evaluates a release against a contract. Returns a job.",
      tag: "releases",
      body: EvaluationRequest.omit({ releaseKey: true }),
      response: JobAcceptedResponse.extend({ evaluationId: z.string() }),
      successStatus: 202,
      errors: ["CONTRACT_CONFLICT", "JOB_ALREADY_RUNNING"],
    },
    async ({ params, body }) => {
      const releaseId = requireUuid(params["releaseId"] ?? "", "release");
      const release = await findRelease(sql, releaseId);
      if (!release) throw notFound("release", releaseId);
      const result = await submitEvaluation({
        agentId: release.agentId,
        contractId: requireUuid(body.contractId, "contract"),
        releaseKey: release.releaseKey,
        environment: body.environment ?? release.environment,
        scope: body.scope ?? "release",
        rootSpanName: body.rootSpanName,
        startMs: body.startMs,
        endMs: body.endMs,
        maxTraces: body.maxTraces,
      });
      return {
        jobId: result.submitted.job.id,
        status: result.submitted.job.status,
        created: result.submitted.created,
        idempotencyKey: result.idempotencyKey,
        evaluationId: result.evaluationId,
        job: jobDto(result.submitted.job),
      };
    },
  );

  // -------------------------------------------------------------------------
  // 15.8 Violations (FR-017)
  // -------------------------------------------------------------------------

  const violationDto = (violation: NonNullable<Awaited<ReturnType<typeof findViolation>>>) => ({
    id: violation.id,
    runEvaluationId: violation.runEvaluationId,
    violationKey: violation.violationKey,
    ruleKey: violation.ruleKey,
    ruleType: violation.ruleType,
    violationType: violation.violationType,
    severity: violation.severity,
    zeroTolerance: violation.zeroTolerance,
    message: violation.message,
    expected: violation.expected,
    observed: violation.observed,
    signozWebUrl: violation.signozWebUrl,
    traceId: violation.traceId,
    releaseKey: violation.releaseKey,
    contractId: violation.contractId,
    contractVersion: violation.contractVersion,
    createdAt: violation.createdAt.toISOString(),
  });

  registry.add(
    server,
    {
      method: "GET",
      url: "/api/projects/:projectId/violations",
      summary: "Violations across a project, newest first.",
      tag: "violations",
      query: PageQuery.extend({
        severity: z.enum(["low", "medium", "high", "critical"]).optional(),
        releaseId: z.string().optional(),
      }),
      response: page(ViolationResponse),
      errors: [],
    },
    async ({ params, query }) => {
      const projectId = requireUuid(params["projectId"] ?? "", "project");
      if (!(await findProject(sql, projectId))) throw notFound("project", projectId);
      const result = await listProjectViolations(
        sql,
        projectId,
        {
          ...(query.severity === undefined ? {} : { severity: query.severity }),
          ...(query.releaseId === undefined
            ? {}
            : { releaseId: requireUuid(query.releaseId, "release") }),
        },
        toPageRequest(query),
      );
      return { items: result.items.map(violationDto), nextCursor: result.nextCursor };
    },
  );

  registry.add(
    server,
    {
      method: "GET",
      url: "/api/violations/:violationId",
      summary: "One violation.",
      tag: "violations",
      response: ViolationResponse,
      errors: [],
    },
    async ({ params }) => {
      const id = requireUuid(params["violationId"] ?? "", "violation");
      const violation = await findViolation(sql, id);
      if (!violation) throw notFound("violation", id);
      return violationDto(violation);
    },
  );

  registry.add(
    server,
    {
      method: "GET",
      url: "/api/violations/:violationId/evidence",
      summary:
        "FR-017's evidence bundle: trace, spans, release, contract and version, rule, SigNoz link, evaluator version.",
      tag: "violations",
      response: z.object({
        violationId: z.string(),
        traceId: z.string(),
        traceRunId: z.string(),
        spanIds: z.array(z.string()),
        canonicalNodes: z.array(z.number()),
        labels: z.array(z.string()),
        releaseId: z.string().nullable(),
        releaseKey: z.string().nullable(),
        contractId: z.string(),
        contractVersion: z.string(),
        contractContentHash: z.string(),
        ruleKey: z.string(),
        signozWebUrl: z.string().nullable(),
        evaluatedAt: IsoDate.nullable(),
        evaluatorVersion: z.string(),
        summary: z.object({
          message: z.string(),
          expected: z.string(),
          observed: z.string(),
        }),
      }),
      errors: [],
    },
    async ({ params }) => {
      const id = requireUuid(params["violationId"] ?? "", "violation");
      const violation = await findViolation(sql, id);
      if (!violation) throw notFound("violation", id);
      const evidence = (violation.evidence ?? {}) as {
        spanIds?: unknown;
        canonicalNodes?: unknown;
        labels?: unknown;
      };
      const strings = (value: unknown): string[] =>
        Array.isArray(value)
          ? value.filter((entry): entry is string => typeof entry === "string")
          : [];
      const numbers = (value: unknown): number[] =>
        Array.isArray(value)
          ? value.filter((entry): entry is number => typeof entry === "number")
          : [];

      return {
        violationId: violation.id,
        traceId: violation.traceId,
        traceRunId: violation.traceRunId,
        spanIds: strings(evidence.spanIds),
        canonicalNodes: numbers(evidence.canonicalNodes),
        labels: strings(evidence.labels),
        releaseId: violation.releaseId,
        releaseKey: violation.releaseKey,
        contractId: violation.contractId,
        contractVersion: violation.contractVersion,
        contractContentHash: violation.contractContentHash,
        ruleKey: violation.ruleKey,
        signozWebUrl: violation.signozWebUrl,
        evaluatedAt: iso(violation.evaluatedAt),
        evaluatorVersion: violation.evaluatorVersion,
        summary: {
          message: violation.message,
          expected: violation.expected,
          observed: violation.observed,
        },
      };
    },
  );
}

/**
 * The miner's selection hash, recomputed at the API edge.
 *
 * `resolveSelection` and `selectionHash` are the authority; this calls them rather than hashing a
 * shape of its own, so the key the API writes is exactly the key the worker's mining run derives.
 */
function miningSelectionHash(selection: {
  projectKey: string;
  agentKey: string;
  releaseId: string;
  environment: string | null;
  startMs: number;
  endMs: number;
  minimumRuns: number;
  rootSpanName: string;
  successfulRunsOnly: boolean;
  excludeMissingRootSpan: boolean;
  rareThreshold: number;
  maxTraces: number;
  representativesPerFamily: number;
  maxSpansPerTrace: number;
}): string {
  return selectionHashOf(resolveSelectionOf(selection));
}
