import {
  aggregateRelease,
  hashReleaseEvaluation,
  type ReleaseEvaluation,
} from "@flightrules/contract-engine";
import { parseContract } from "@flightrules/contract-schema";
import {
  findAgent,
  findContract,
  findLatestReleaseEvaluation,
  findProject,
  findRelease,
  findReleaseBaselineReference,
  listReleaseEvaluations,
  listReleaseRunRecords,
} from "@flightrules/db";
import { FlightRulesError } from "@flightrules/domain";
import { FLIGHT_RULES, SPAN_NAMES, withFlightRulesSpan } from "@flightrules/telemetry";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { notFound, requireUuid } from "../http.js";
import type { RouteRegistry } from "../registry.js";

/**
 * The release gate (PRD section 15.7, FR-011, FR-012).
 *
 * `GET /api/releases/:releaseId/gate` is a **read**. It runs no job, fetches no trace and writes no
 * row: it loads the release's most recent completed evaluation, hands the persisted evidence to the
 * pure aggregation in `@flightrules/contract-engine`, and returns the decision. Two consequences
 * matter and both are tested: the route is idempotent, and a restarted API serving the same
 * database returns the same decision, because nothing about the decision lives in this process.
 *
 * Nothing here decides anything either. No LLM is involved, and no branch in this file can turn a
 * `fail` into a `pass`.
 */

const RateSchema = z.object({
  numerator: z.number(),
  denominator: z.number(),
  decimal: z.string(),
  percent: z.string(),
});

const ChangeSchema = z.object({
  metric: z.string(),
  baseline: z.number().nullable(),
  candidate: z.number().nullable(),
  changePercent: z.string().nullable(),
  measured: z.boolean(),
});

const FindingSchema = z.object({
  code: z.string(),
  implies: z.string(),
  severity: z.string(),
  summary: z.string(),
  expected: z.string(),
  observed: z.string(),
  ruleId: z.string().nullable(),
});

const DisclosureSchema = z.object({
  code: z.string(),
  summary: z.string(),
  ruleId: z.string().nullable(),
});

const ReleaseRuleSchema = z.object({
  ruleId: z.string(),
  ruleType: z.string(),
  severity: z.string(),
  outcome: z.string(),
  aggregation: z.string(),
  metric: z.string(),
  observed: z.number().nullable(),
  limit: z.number(),
  runsReporting: z.number(),
  summary: z.string(),
});

/**
 * The gate response.
 *
 * Declared field by field rather than as `z.unknown()`, because the registry validates every
 * response against its declaration before sending: an extra key would be a leak and a missing one
 * would be a silently broken CLI. No raw database row and no raw MCP payload appears anywhere in it.
 */
const GateResponse = z.object({
  schemaVersion: z.string(),
  decision: z.enum(["pass", "fail", "insufficient_data", "error"]),
  exitCode: z.number().int(),
  releaseId: z.string(),
  releaseKey: z.string(),
  environment: z.string(),
  agentId: z.string(),
  projectId: z.string(),
  evaluationId: z.string(),
  evaluationStatus: z.string(),
  contractId: z.string(),
  contractKey: z.string(),
  contractVersion: z.string(),
  contractContentHash: z.string(),
  contractState: z.string(),
  evaluatorVersion: z.string(),
  baselineReleaseKey: z.string().nullable(),
  decisionHash: z.string(),
  window: z.object({ startMs: z.number(), endMs: z.number() }),
  retrieval: z.object({
    truncated: z.boolean(),
    requested: z.number(),
    returned: z.number(),
  }),
  gate: z.object({
    minCompletedRuns: z.number(),
    evaluationTimeoutSeconds: z.number(),
    maxViolationPercent: z.string(),
    maxUnknownRoutePercent: z.string(),
    maxLatencyRegressionPercent: z.string(),
    maxTokenRegressionPercent: z.string(),
    zeroToleranceRuleIds: z.array(z.string()),
  }),
  counts: z.object({
    evaluatedRuns: z.number(),
    passedRuns: z.number(),
    failedRuns: z.number(),
    erroredRuns: z.number(),
    insufficientRuns: z.number(),
    violations: z.number(),
    criticalViolations: z.number(),
    zeroToleranceViolations: z.number(),
    unknownRouteRuns: z.number(),
    duplicateSideEffectRuns: z.number(),
    missingPrerequisiteRuns: z.number(),
    degradedTraceRuns: z.number(),
    severities: z.object({
      low: z.number(),
      medium: z.number(),
      high: z.number(),
      critical: z.number(),
    }),
    observedRouteFamilies: z.number(),
    approvedRouteFamiliesCovered: z.number(),
    approvedRouteFamiliesDeclared: z.number(),
  }),
  rates: z.object({
    violation: RateSchema,
    unknownRoute: RateSchema,
    duplicateSideEffect: RateSchema,
    missingPrerequisite: RateSchema,
  }),
  changes: z.object({
    latency: ChangeSchema,
    tokens: ChangeSchema,
    retries: ChangeSchema,
  }),
  releaseRules: z.array(ReleaseRuleSchema),
  findings: z.array(FindingSchema),
  disclosures: z.array(DisclosureSchema),
  evidence: z.object({
    representativeFailingTraceIds: z.array(z.string()),
    representativePassingTraceIds: z.array(z.string()),
    zeroToleranceRuleIds: z.array(z.string()),
    violatedRuleIds: z.array(z.string()),
    observedRouteFingerprints: z.array(z.string()),
  }),
  history: z.array(
    z.object({
      evaluationId: z.string(),
      status: z.string(),
      completedAt: z.string().nullable(),
    }),
  ),
  /** The only field that changes between two otherwise identical reads. */
  retrievedAt: z.string(),
});

const GateQuery = z.object({
  /** Restricts the gate to one contract, so a caller can pin the version it is gating on. */
  contractId: z.string().optional(),
  /** How old the aggregation window may be before the decision is reported stale. */
  maxAgeSeconds: z.coerce
    .number()
    .int()
    .min(60)
    .max(30 * 24 * 3600)
    .optional(),
  historyLimit: z.coerce.number().int().min(0).max(50).optional(),
});

/** Matches the CLI's table. Duplicated as a literal number so the API has no CLI dependency. */
const EXIT_CODE_BY_DECISION: Readonly<Record<ReleaseEvaluation["decision"], number>> = {
  pass: 0,
  fail: 2,
  insufficient_data: 3,
  error: 4,
};

const DEFAULT_MAX_AGE_SECONDS = 24 * 3600;

export function registerGateRoutes(
  server: FastifyInstance,
  registry: RouteRegistry,
  context: AppContext,
): void {
  const { sql } = context;

  registry.add(
    server,
    {
      method: "GET",
      url: "/api/releases/:releaseId/gate",
      summary:
        "The deterministic release-gate decision for a release, aggregated from its persisted run evaluations.",
      tag: "releases",
      query: GateQuery,
      response: GateResponse,
      errors: ["RELEASE_INSUFFICIENT_DATA", "CONTRACT_INVALID", "STATE_TRANSITION_INVALID"],
    },
    async ({ params, query }) => {
      const releaseId = requireUuid(params["releaseId"] ?? "", "release");
      const release = await findRelease(sql, releaseId);
      if (!release) throw notFound("release", releaseId);

      const agent = await findAgent(sql, release.agentId);
      if (!agent) throw notFound("agent", release.agentId);
      const project = await findProject(sql, agent.projectId);
      if (!project) throw notFound("project", agent.projectId);

      const header = await findLatestReleaseEvaluation(sql, releaseId, {
        contractId:
          query.contractId === undefined ? undefined : requireUuid(query.contractId, "contract"),
      });
      if (!header) {
        // Not an empty pass and not a 404 on the release: the release exists and has never been
        // judged. PRD section 19's own code for that state, so a CLI exits 3 rather than 0.
        throw new FlightRulesError("RELEASE_INSUFFICIENT_DATA", {
          message:
            "This release has no completed evaluation, so no release decision has been produced.",
          details: { releaseId, releaseKey: release.releaseKey },
        });
      }

      const contract = await findContract(sql, header.contractId);
      if (!contract) throw notFound("contract", header.contractId);

      const parsed = parseContract(contract.yamlText);
      if (!parsed.ok) {
        throw new FlightRulesError("CONTRACT_INVALID", {
          message:
            "The stored contract this release was evaluated against no longer validates, so no decision may be derived from it.",
          details: { contractId: contract.id, errors: parsed.errors.length },
        });
      }

      const [runs, baseline, history] = await Promise.all([
        listReleaseRunRecords(sql, header.id),
        findReleaseBaselineReference(sql, contract.id),
        listReleaseEvaluations(sql, releaseId, query.historyLimit ?? 10),
      ]);

      const summary = (header.summary ?? {}) as {
        readonly requestedRuns?: unknown;
        readonly truncated?: unknown;
      };
      const requested =
        typeof summary.requestedRuns === "number" ? summary.requestedRuns : runs.length;

      const windowStartMs = (header.windowStart ?? header.createdAt).getTime();
      const windowEndMs = (header.windowEnd ?? header.completedAt ?? header.createdAt).getTime();
      const now = context.now();

      const decision = await withFlightRulesSpan(
        SPAN_NAMES.releaseGate,
        {
          [FLIGHT_RULES.projectId]: project.id,
          [FLIGHT_RULES.agentId]: agent.id,
          [FLIGHT_RULES.contractId]: contract.id,
          [FLIGHT_RULES.contractVersion]: contract.semanticVersion,
          [FLIGHT_RULES.releaseId]: release.id,
          [FLIGHT_RULES.evaluationId]: header.id,
          "flight_rules.run.count": runs.length,
        },
        async () =>
          aggregateRelease({
            contract: parsed.value.contract,
            contractContentHash: contract.contentHash,
            contractState: contract.status,
            releaseKey: release.releaseKey,
            environment: release.environment,
            runs,
            baseline,
            retrieval: {
              truncated: summary.truncated === true || requested > runs.length,
              requested,
              returned: runs.length,
            },
            window: { startMs: windowStartMs, endMs: windowEndMs },
            evaluationStartedMs: header.startedAt?.getTime() ?? null,
            evaluationCompletedMs: header.completedAt?.getTime() ?? null,
            nowMs: now.getTime(),
            maxAgeSeconds: query.maxAgeSeconds ?? DEFAULT_MAX_AGE_SECONDS,
          }),
      );

      context.metrics?.recordGateDecision(
        {
          projectId: project.id,
          agentId: agent.id,
          projectSlug: project.slug,
          agentKey: agent.agentKey,
          releaseId: release.id,
          releaseKey: release.releaseKey,
          scope: "release",
        },
        decision.decision,
      );

      return {
        ...decision,
        gate: { ...decision.gate, zeroToleranceRuleIds: [...decision.gate.zeroToleranceRuleIds] },
        releaseRules: [...decision.releaseRules],
        findings: [...decision.findings],
        disclosures: [...decision.disclosures],
        evidence: {
          representativeFailingTraceIds: [...decision.evidence.representativeFailingTraceIds],
          representativePassingTraceIds: [...decision.evidence.representativePassingTraceIds],
          zeroToleranceRuleIds: [...decision.evidence.zeroToleranceRuleIds],
          violatedRuleIds: [...decision.evidence.violatedRuleIds],
          observedRouteFingerprints: [...decision.evidence.observedRouteFingerprints],
        },
        exitCode: EXIT_CODE_BY_DECISION[decision.decision],
        releaseId: release.id,
        agentId: agent.id,
        projectId: project.id,
        evaluationId: header.id,
        evaluationStatus: header.status,
        contractId: contract.id,
        contractKey: contract.contractKey,
        decisionHash: hashReleaseEvaluation(decision),
        history: history.map((entry) => ({
          evaluationId: entry.id,
          status: entry.status,
          completedAt: entry.completedAt?.toISOString() ?? null,
        })),
        retrievedAt: now.toISOString(),
      };
    },
  );
}
