import "server-only";
import { z } from "zod";
import {
  AgentSchema,
  ArtifactsSchema,
  apiGet,
  BaselineSummarySchema,
  ContractSchema,
  GateSchema,
  isFailure,
  ProjectSchema,
  page,
  ReleaseSchema,
  ViolationSchema,
} from "./api";

/**
 * The reads each route needs, named once.
 *
 * Every route below the project level needs the project and the agent for its heading and its
 * breadcrumbs, so fetching them is factored here rather than repeated fourteen times. Each helper
 * returns the typed result, never throws, and never falls back to a placeholder: a route that could
 * not load its subject renders an error state rather than a page with blanks in it.
 */

export const findProject = (projectId: string) =>
  apiGet(`/api/projects/${projectId}`, ProjectSchema);

export const findAgent = (agentId: string) => apiGet(`/api/agents/${agentId}`, AgentSchema);

export const listAgents = (projectId: string) =>
  apiGet(`/api/projects/${projectId}/agents?limit=100`, page(AgentSchema));

export const listReleases = (agentId: string) =>
  apiGet(`/api/agents/${agentId}/releases?limit=100`, page(ReleaseSchema));

export const listContracts = (agentId: string) =>
  apiGet(`/api/agents/${agentId}/contracts?limit=100`, page(ContractSchema));

export const listBaselines = (agentId: string) =>
  apiGet(`/api/agents/${agentId}/baselines?limit=100`, page(BaselineSummarySchema));

export const listViolations = (projectId: string) =>
  apiGet(`/api/projects/${projectId}/violations?limit=100`, page(ViolationSchema));

export const findGate = (releaseId: string) =>
  apiGet(`/api/releases/${releaseId}/gate`, GateSchema);

export const listArtifacts = (projectId: string) =>
  apiGet(`/api/setup/signoz/artifacts?projectId=${projectId}`, ArtifactsSchema);

export const findRelease = (releaseId: string) =>
  apiGet(`/api/releases/${releaseId}`, ReleaseSchema);

export const findContract = (contractId: string) =>
  apiGet(
    `/api/contracts/${contractId}`,
    ContractSchema.extend({
      yaml: z.string().optional(),
      canonical: z.unknown().optional(),
      rules: z
        .array(
          z.object({
            ruleKey: z.string(),
            ruleType: z.string(),
            severity: z.string(),
            zeroTolerance: z.boolean(),
            rule: z.unknown(),
            evidenceBasis: z.unknown().nullable(),
          }),
        )
        .optional(),
    }),
  );

export const findBaseline = (baselineId: string) =>
  apiGet(
    `/api/baselines/${baselineId}`,
    z.object({
      id: z.string(),
      agentId: z.string(),
      baselineIdentifier: z.string(),
      status: z.string(),
      environment: z.string().nullable(),
      sourceTimeStart: z.string(),
      sourceTimeEnd: z.string(),
      minimumRuns: z.number(),
      counts: z.unknown(),
      retrieval: z.unknown(),
      excluded: z.unknown(),
      disclosures: z.unknown(),
      createdAt: z.string(),
      families: z.array(
        z.object({
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
          decidedAt: z.string().nullable(),
        }),
      ),
    }),
  );

/**
 * The gate decision for every release of an agent.
 *
 * A release with no completed evaluation answers `RELEASE_INSUFFICIENT_DATA`, which is a fact about
 * that release rather than a failure of the page, so it is carried as `null` and rendered as the
 * releases table's own "not evaluated" cell.
 */
export async function gatesForReleases(
  releases: readonly { readonly id: string }[],
): Promise<ReadonlyMap<string, Awaited<ReturnType<typeof findGate>>>> {
  const entries = await Promise.all(
    releases.map(async (release) => [release.id, await findGate(release.id)] as const),
  );
  return new Map(entries);
}

export function decisionOf(result: Awaited<ReturnType<typeof findGate>>): string {
  return isFailure(result) ? "not evaluated" : result.data.decision;
}
