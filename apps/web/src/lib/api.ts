import "server-only";
import { type ZodType, z } from "zod";

/**
 * The web application's only outward connection (PRD section 12.3).
 *
 * The browser never sees this module. `server-only` makes that a build error rather than a
 * convention: importing it from a client component fails to compile. The API base URL, and every
 * header the product might one day add, therefore stay on the server, and there is no path by which
 * a SigNoz credential could reach a page (PRD section 8.2: "Credentials stay on the server and are
 * never exposed to the browser").
 *
 * Every response is validated against a declared schema before a field is read. A status code is
 * not proof of success — PRD section 16 records a SigNoz path returning a single-page-application
 * shell with HTTP 200 (SL-012) — so the content type is checked too.
 *
 * A failure is a typed `ApiFailure`, never a thrown string, so a route renders its error state with
 * the product's own error code rather than a stack trace.
 */

export const API_BASE_URL = (process.env["FLIGHTRULES_API_URL"] ?? "http://localhost:4000").replace(
  /\/+$/,
  "",
);

export interface ApiFailure {
  readonly kind: "failure";
  readonly code: string;
  readonly message: string;
  readonly status: number | null;
}

export interface ApiSuccess<T> {
  readonly kind: "success";
  readonly data: T;
}

export type ApiResult<T> = ApiSuccess<T> | ApiFailure;

export function isFailure<T>(result: ApiResult<T>): result is ApiFailure {
  return result.kind === "failure";
}

const ErrorEnvelope = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    requestId: z.string(),
  }),
});

const REQUEST_TIMEOUT_MS = 15_000;

export async function apiGet<T>(path: string, schema: ZodType<T>): Promise<ApiResult<T>> {
  return request("GET", path, undefined, schema);
}

export async function apiPost<T>(
  path: string,
  body: unknown,
  schema: ZodType<T>,
): Promise<ApiResult<T>> {
  return request("POST", path, body, schema);
}

async function request<T>(
  method: string,
  path: string,
  body: unknown,
  schema: ZodType<T>,
): Promise<ApiResult<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      method,
      headers: {
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: controller.signal,
      // Product state changes when a job finishes; a cached page would show a stale decision.
      cache: "no-store",
    });
  } catch {
    return {
      kind: "failure",
      code: "SIGNOZ_UNREACHABLE",
      message: "FlightRules could not reach its API.",
      status: null,
    };
  } finally {
    clearTimeout(timer);
  }

  const contentType = response.headers.get("content-type") ?? "";
  const text = await response.text();

  if (!contentType.includes("application/json")) {
    return {
      kind: "failure",
      code: "MCP_RESPONSE_INVALID",
      message: "The API returned a response that was not JSON.",
      status: response.status,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {
      kind: "failure",
      code: "MCP_RESPONSE_INVALID",
      message: "The API returned a body that is not valid JSON.",
      status: response.status,
    };
  }

  if (!response.ok) {
    const envelope = ErrorEnvelope.safeParse(parsed);
    return envelope.success
      ? {
          kind: "failure",
          code: envelope.data.error.code,
          message: envelope.data.error.message,
          status: response.status,
        }
      : {
          kind: "failure",
          code: "EVALUATION_FAILED",
          message: `The API returned HTTP ${String(response.status)}.`,
          status: response.status,
        };
  }

  const validated = schema.safeParse(parsed);
  if (!validated.success) {
    return {
      kind: "failure",
      code: "MCP_RESPONSE_INVALID",
      message: "The API response did not match the shape this page requires.",
      status: response.status,
    };
  }
  return { kind: "success", data: validated.data };
}

/* -------------------------------------------------------------------------- */
/* Schemas                                                                    */
/* -------------------------------------------------------------------------- */

export const page = <T>(item: ZodType<T>) =>
  z.object({ items: z.array(item), nextCursor: z.string().nullable() });

export const ProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  description: z.string(),
  defaultEnvironment: z.string(),
  signozConnectionId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Project = z.infer<typeof ProjectSchema>;

export const AgentSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  name: z.string(),
  agentKey: z.string(),
  workflowNameMatcher: z.string(),
  rootSpanMatcher: z.record(z.string(), z.unknown()),
  serviceMatchers: z.array(z.string()),
  releaseAttributeKey: z.string(),
  environmentAttributeKey: z.string(),
  normaliserConfigId: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Agent = z.infer<typeof AgentSchema>;

export const ReleaseSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  releaseKey: z.string(),
  environment: z.string(),
  commitSha: z.string().nullable(),
  imageDigest: z.string().nullable(),
  firstObservedAt: z.string().nullable(),
  lastObservedAt: z.string().nullable(),
  createdAt: z.string(),
});
export type Release = z.infer<typeof ReleaseSchema>;

export const ContractSchema = z.object({
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
  validationErrors: z.array(z.unknown()),
  approvedAt: z.string().nullable(),
  activatedAt: z.string().nullable(),
  supersededAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Contract = z.infer<typeof ContractSchema>;

const CanonicalNodeSchema = z.object({
  order: z.number(),
  depth: z.number(),
  label: z.string(),
  service: z.string(),
  kind: z.string().nullable().default(null),
  sideEffect: z.string(),
  tool: z.string().nullable().default(null),
  dataDomain: z.string().nullable().default(null),
  retryNumber: z.number().nullable().default(null),
});

export const CanonicalGraphSchema = z.object({
  nodes: z.array(CanonicalNodeSchema),
  edges: z.array(z.object({ from: z.number(), to: z.number(), type: z.string() })),
});

export const RouteFamilySchema = z.object({
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
});
export type RouteFamily = z.infer<typeof RouteFamilySchema>;

export const BaselineSchema = z.object({
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
  families: z.array(RouteFamilySchema),
});
export type Baseline = z.infer<typeof BaselineSchema>;

export const BaselineSummarySchema = z.object({
  id: z.string(),
  baselineIdentifier: z.string(),
  status: z.string(),
  environment: z.string().nullable(),
  createdAt: z.string(),
});

export const ViolationSchema = z.object({
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
  createdAt: z.string(),
});
export type Violation = z.infer<typeof ViolationSchema>;

export const ViolationEvidenceSchema = z.object({
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
  evaluatedAt: z.string().nullable(),
  evaluatorVersion: z.string(),
});

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

export const GateSchema = z.object({
  schemaVersion: z.string(),
  decision: z.enum(["pass", "fail", "insufficient_data", "error"]),
  exitCode: z.number(),
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
  gate: z.object({
    minCompletedRuns: z.number(),
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
  changes: z.object({ latency: ChangeSchema, tokens: ChangeSchema, retries: ChangeSchema }),
  releaseRules: z.array(
    z.object({
      ruleId: z.string(),
      outcome: z.string(),
      metric: z.string(),
      observed: z.number().nullable(),
      limit: z.number(),
      summary: z.string(),
    }),
  ),
  findings: z.array(
    z.object({
      code: z.string(),
      implies: z.string(),
      severity: z.string(),
      summary: z.string(),
      expected: z.string(),
      observed: z.string(),
      ruleId: z.string().nullable(),
    }),
  ),
  disclosures: z.array(
    z.object({ code: z.string(), summary: z.string(), ruleId: z.string().nullable() }),
  ),
  evidence: z.object({
    representativeFailingTraceIds: z.array(z.string()),
    representativePassingTraceIds: z.array(z.string()),
    zeroToleranceRuleIds: z.array(z.string()),
    violatedRuleIds: z.array(z.string()),
    observedRouteFingerprints: z.array(z.string()),
  }),
  retrievedAt: z.string(),
});
export type Gate = z.infer<typeof GateSchema>;

export const DependenciesSchema = z.object({
  database: z.object({ status: z.enum(["up", "down"]) }),
  signoz: z.object({
    status: z.enum(["up", "degraded", "down"]),
    missingTools: z.array(z.string()),
  }),
});
export type Dependencies = z.infer<typeof DependenciesSchema>;

export const CapabilitiesSchema = z.object({
  connectionId: z.string().nullable(),
  status: z.string(),
  lastVerifiedAt: z.string().nullable(),
  capabilities: z
    .object({
      server: z.object({ name: z.string(), version: z.string() }).nullable().optional(),
      toolNames: z.array(z.string()).optional(),
      requiredPresent: z.array(z.string()).optional(),
      requiredMissing: z.array(z.string()).optional(),
      satisfied: z.boolean().optional(),
    })
    .nullable(),
});

export const ArtifactSchema = z.object({
  id: z.string(),
  artifactType: z.string(),
  managedName: z.string(),
  status: z.string(),
  signozResourceId: z.string().nullable(),
  signozWebUrl: z.string().nullable(),
  specHash: z.string(),
  lastSyncedAt: z.string().nullable(),
  lastVerifiedAt: z.string().nullable(),
  lastOperation: z.string().nullable(),
});
export type Artifact = z.infer<typeof ArtifactSchema>;

export const ArtifactsSchema = z.object({
  items: z.array(ArtifactSchema),
  summary: z.record(z.string(), z.number()),
});

export const EvaluationSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  contractId: z.string(),
  releaseId: z.string().nullable(),
  scope: z.string(),
  status: z.string(),
  evaluatorVersion: z.string(),
  summary: z.unknown(),
  completedAt: z.string().nullable(),
  createdAt: z.string(),
});

export const DemoStatusSchema = z.object({
  demoMode: z.boolean(),
  projectId: z.string().nullable(),
  agentId: z.string().nullable(),
  baselineCount: z.number(),
  contractCount: z.number(),
  activeContractId: z.string().nullable(),
  activeContractHash: z.string().nullable(),
  checkedAt: z.string(),
});
