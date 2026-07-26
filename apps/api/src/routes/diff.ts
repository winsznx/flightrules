import {
  findAgent,
  findContract,
  findLatestReleaseEvaluation,
  findProject,
  findRelease,
  listApprovedRouteGraphs,
  listCandidateRunGraphs,
  readCanonicalGraph,
} from "@flightrules/db";
import { FlightRulesError } from "@flightrules/domain";
import { traceLink } from "@flightrules/signoz-mcp";
import {
  type CanonicalGraph,
  diffCanonicalGraphs,
  GRAPH_CHANGE_KINDS,
  type GraphChange,
  unknownRouteChange,
} from "@flightrules/trace-graph";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { notFound, requireUuid } from "../http.js";
import type { RouteRegistry } from "../registry.js";

/**
 * The release diff (PRD section 15.7, section 8.11, FR-011).
 *
 * A **read**, like the gate beside it. No job, no trace fetch, no row written: it compares two
 * canonical graphs the database already holds and returns the typed change list
 * `packages/trace-graph/src/diff.ts` produces.
 *
 * Three properties this route exists to guarantee, all of which the browser could otherwise get
 * wrong:
 *
 * 1. **The comparison is server-side and deterministic.** The same release always yields the same
 *    change list, in the same order, because `diffCanonicalGraphs` sorts by kind then subject and
 *    the candidate is selected by a stable ordering rather than by whichever row came back first.
 * 2. **The baseline side is an *approved* route family**, never "the previous release". A release
 *    is judged against what a human sanctioned.
 * 3. **The nearest approved route is the evaluator's own judgement**, read from
 *    `run_evaluations.nearest_route_family_id`, not recomputed here and never guessed by similarity
 *    in a page.
 *
 * Nothing is fabricated. A release with no completed evaluation returns `RELEASE_INSUFFICIENT_DATA`
 * rather than an empty diff, because "nothing changed" and "we have not looked" are different
 * answers and only one of them is safe to show.
 */

/** How many evaluated runs are considered when choosing representatives. */
const CANDIDATE_LIMIT = 200;

const ChangeSchema = z.object({
  kind: z.enum(GRAPH_CHANGE_KINDS),
  subject: z.string(),
  detail: z.string(),
  baselineCount: z.number().nullable(),
  candidateCount: z.number().nullable(),
  /** PRD section 8.11's own label for this kind, so the page never invents wording. */
  label: z.string(),
  severity: z.enum(["structural", "behavioural", "informational"]),
});

const GraphNodeSchema = z.object({
  order: z.number(),
  depth: z.number(),
  label: z.string(),
  service: z.string(),
  kind: z.string().nullable(),
  sideEffect: z.string(),
  tool: z.string().nullable(),
  dataDomain: z.string().nullable(),
  retryNumber: z.number().nullable(),
});

const GraphSchema = z.object({
  nodes: z.array(GraphNodeSchema),
  edges: z.array(z.object({ from: z.number(), to: z.number(), type: z.string() })),
});

const TraceSchema = z.object({
  traceId: z.string(),
  traceRunId: z.string(),
  status: z.string(),
  routeFingerprint: z.string(),
  routeApproved: z.boolean(),
  similarity: z.string(),
  durationMs: z.number().nullable(),
  signozWebUrl: z.string().nullable(),
});

const DiffResponse = z.object({
  schemaVersion: z.string(),
  releaseId: z.string(),
  releaseKey: z.string(),
  environment: z.string(),
  agentId: z.string(),
  projectId: z.string(),
  evaluationId: z.string(),
  evaluationStatus: z.string(),
  contractId: z.string(),
  contractVersion: z.string(),
  contractContentHash: z.string(),
  evaluatorVersion: z.string(),
  /** `null` when the release has no approved family to compare against, which is disclosed. */
  baseline: z
    .object({
      routeFamilyId: z.string(),
      fingerprint: z.string(),
      occurrenceCount: z.number(),
      graph: GraphSchema,
    })
    .nullable(),
  candidate: z
    .object({
      trace: TraceSchema,
      graph: GraphSchema,
    })
    .nullable(),
  /** The evaluator's own nearest-approved-family judgement for the representative run. */
  nearestApprovedRouteFamilyId: z.string().nullable(),
  identical: z.boolean(),
  changes: z.array(ChangeSchema),
  representativeFailingTraces: z.array(TraceSchema),
  representativePassingTraces: z.array(TraceSchema),
  approvedRouteCount: z.number(),
  /** Reasons the diff is partial or absent. Never silently empty. */
  disclosures: z.array(z.object({ code: z.string(), summary: z.string() })),
  retrievedAt: z.string(),
});

/**
 * PRD section 8.11's twelve required diff labels, mapped onto the engine's change kinds.
 *
 * The mapping is here rather than in the page for the same reason the exit-code table lives in the
 * engine: two surfaces that name the same change differently are two surfaces that disagree. A kind
 * with no PRD label falls back to its own name rather than being hidden, so a change the PRD did not
 * anticipate is still reported.
 */
const CHANGE_LABELS: Readonly<
  Record<
    string,
    { readonly label: string; readonly severity: "structural" | "behavioural" | "informational" }
  >
> = {
  node_added: { label: "Added step", severity: "structural" },
  node_removed: { label: "Removed step", severity: "structural" },
  edge_added: { label: "New edge", severity: "structural" },
  edge_removed: { label: "Missing edge", severity: "structural" },
  cardinality_changed: { label: "Cardinality changed", severity: "behavioural" },
  tool_added: { label: "New tool", severity: "behavioural" },
  service_added: { label: "New service", severity: "behavioural" },
  data_domain_added: { label: "New data domain", severity: "behavioural" },
  retry_increased: { label: "Retry increase", severity: "behavioural" },
  side_effect_duplicated: { label: "Duplicate side effect", severity: "structural" },
  attribute_changed: { label: "Attribute changed", severity: "informational" },
  route_unknown: { label: "Route not approved", severity: "structural" },
};

function labelled(change: GraphChange): z.infer<typeof ChangeSchema> {
  const mapped = CHANGE_LABELS[change.kind] ?? {
    label: change.kind.replace(/_/g, " "),
    severity: "informational" as const,
  };
  return {
    kind: change.kind,
    subject: change.subject,
    detail: change.detail,
    baselineCount: change.baselineCount ?? null,
    candidateCount: change.candidateCount ?? null,
    label: mapped.label,
    severity: mapped.severity,
  };
}

/** The wire form of a canonical graph: the ordered node list and its edges, and nothing else. */
function graphDto(graph: CanonicalGraph): z.infer<typeof GraphSchema> {
  return {
    nodes: graph.nodes.map((node) => ({
      order: node.order,
      depth: node.depth,
      label: node.label,
      service: node.service,
      kind: node.kind,
      sideEffect: node.sideEffect,
      tool: node.tool,
      dataDomain: node.dataDomain,
      retryNumber: node.retryNumber,
    })),
    edges: graph.edges.map((edge) => ({ from: edge.from, to: edge.to, type: edge.type })),
  };
}

/** Reads a stored canonical graph, or `null` when the row has none rather than throwing. */
function canonicalOrNull(value: unknown): CanonicalGraph | null {
  if (value === null || value === undefined) return null;
  try {
    return readCanonicalGraph(value);
  } catch {
    return null;
  }
}

export function registerDiffRoutes(
  server: FastifyInstance,
  registry: RouteRegistry,
  context: AppContext,
): void {
  const { sql, config } = context;

  registry.add(
    server,
    {
      method: "GET",
      url: "/api/releases/:releaseId/diff",
      summary:
        "The typed topology diff between a release's representative run and the nearest approved route family. A read: no job, no trace fetch, no row written.",
      tag: "releases",
      query: z.object({ contractId: z.string().optional() }),
      response: DiffResponse,
      errors: ["RELEASE_INSUFFICIENT_DATA"],
    },
    async ({ params, query }) => {
      const releaseId = requireUuid(params["releaseId"] ?? "", "release");
      const release = await findRelease(sql, releaseId);
      if (!release) throw notFound("release", releaseId);

      const agent = await findAgent(sql, release.agentId);
      if (!agent) throw notFound("agent", release.agentId);
      const project = await findProject(sql, agent.projectId);
      if (!project) throw notFound("project", agent.projectId);

      const evaluation = await findLatestReleaseEvaluation(sql, releaseId, {
        ...(query.contractId === undefined
          ? {}
          : { contractId: requireUuid(query.contractId, "contract") }),
      });
      if (!evaluation) {
        // Not an empty diff. A release nobody has evaluated has no observed topology at all, and
        // rendering "no changes" for it would read as "this release is the same as the baseline".
        throw new FlightRulesError("RELEASE_INSUFFICIENT_DATA", {
          message: "This release has no completed evaluation, so no diff can be produced.",
          details: { releaseId },
        });
      }

      const contract = await findContract(sql, evaluation.contractId);
      if (!contract) throw notFound("contract", evaluation.contractId);

      const [approved, runs] = await Promise.all([
        listApprovedRouteGraphs(sql, contract.id),
        listCandidateRunGraphs(sql, evaluation.id, CANDIDATE_LIMIT),
      ]);

      const disclosures: { code: string; summary: string }[] = [];

      const traceDto = (run: (typeof runs)[number]): z.infer<typeof TraceSchema> => ({
        traceId: run.traceId,
        traceRunId: run.traceRunId,
        status: run.status,
        routeFingerprint: run.routeFingerprint,
        routeApproved: run.routeApproved,
        similarity: run.similarity,
        durationMs: run.durationMs,
        // The builder query FlightRules must use to read custom attributes returns no `webUrl`
        // (SL-061), so a link is built from the path SigNoz's own trace-details answer uses and the
        // browser-reachable origin the operator configured. Never a guessed pattern.
        signozWebUrl: traceLink(config.signozUrl, run.traceId, run.signozWebUrl),
      });

      const failing = runs.filter((run) => run.status === "fail");
      const passing = runs.filter((run) => run.status === "pass");

      // The run the page explains. A failing run when there is one, because that is what a
      // regression is; otherwise the first passing run, so a passing release still shows its shape.
      const representative = failing[0] ?? passing[0] ?? runs[0] ?? null;

      if (representative === null) {
        disclosures.push({
          code: "NO_EVALUATED_RUN",
          summary: "The evaluation completed with no run records, so there is nothing to compare.",
        });
      }

      const candidateGraph =
        representative === null ? null : canonicalOrNull(representative.canonical);
      if (representative !== null && candidateGraph === null) {
        disclosures.push({
          code: "CANDIDATE_GRAPH_UNAVAILABLE",
          summary:
            "The representative run has no stored canonical graph, so its topology cannot be compared.",
        });
      }

      // The baseline side is the approved family the evaluator judged this run nearest to; failing
      // that, the most-travelled approved family. Never "the previous release".
      const nearest =
        representative?.nearestRouteFamilyId === undefined ||
        representative.nearestRouteFamilyId === null
          ? null
          : (approved.find(
              (family) => family.routeFamilyId === representative.nearestRouteFamilyId,
            ) ?? null);
      const baselineFamily = nearest ?? approved[0] ?? null;

      if (approved.length === 0) {
        disclosures.push({
          code: "NO_APPROVED_ROUTE",
          summary:
            "This contract's baseline has no approved route family, so there is nothing to compare against.",
        });
      } else if (nearest === null && representative !== null) {
        disclosures.push({
          code: "NEAREST_ROUTE_NOT_RECORDED",
          summary:
            "The evaluator recorded no nearest approved family for the representative run; the most-travelled approved family is used instead.",
        });
      }

      const baselineGraph =
        baselineFamily === null ? null : canonicalOrNull(baselineFamily.canonical);
      if (baselineFamily !== null && baselineGraph === null) {
        disclosures.push({
          code: "BASELINE_GRAPH_UNAVAILABLE",
          summary: "The approved route family has no stored canonical graph.",
        });
      }

      const changes: GraphChange[] = [];
      let identical = false;

      if (baselineGraph !== null && candidateGraph !== null && representative !== null) {
        const diff = diffCanonicalGraphs(baselineGraph, candidateGraph, {
          baseline: baselineFamily?.fingerprint ?? "",
          candidate: representative.routeFingerprint,
        });
        identical = diff.identical;
        changes.push(...diff.changes);

        const unknown = unknownRouteChange(
          representative.routeFingerprint,
          approved.map((family) => family.fingerprint),
        );
        if (unknown !== undefined) changes.push(unknown);
      }

      return {
        schemaVersion: "1",
        releaseId: release.id,
        releaseKey: release.releaseKey,
        environment: release.environment,
        agentId: agent.id,
        projectId: project.id,
        evaluationId: evaluation.id,
        evaluationStatus: evaluation.status,
        contractId: contract.id,
        contractVersion: contract.semanticVersion,
        contractContentHash: contract.contentHash,
        evaluatorVersion: evaluation.evaluatorVersion,
        baseline:
          baselineFamily === null || baselineGraph === null
            ? null
            : {
                routeFamilyId: baselineFamily.routeFamilyId,
                fingerprint: baselineFamily.fingerprint,
                occurrenceCount: baselineFamily.occurrenceCount,
                graph: graphDto(baselineGraph),
              },
        candidate:
          representative === null || candidateGraph === null
            ? null
            : { trace: traceDto(representative), graph: graphDto(candidateGraph) },
        nearestApprovedRouteFamilyId: nearest?.routeFamilyId ?? null,
        identical,
        // Sorted once more at the edge, so the wire order is the engine's order regardless of the
        // order the unknown-route change was appended in.
        changes: [...changes]
          .sort((a, b) =>
            a.kind !== b.kind ? (a.kind < b.kind ? -1 : 1) : a.subject < b.subject ? -1 : 1,
          )
          .map(labelled),
        representativeFailingTraces: failing.slice(0, 5).map(traceDto),
        representativePassingTraces: passing.slice(0, 5).map(traceDto),
        approvedRouteCount: approved.length,
        disclosures,
        retrievedAt: context.now().toISOString(),
      };
    },
  );
}
