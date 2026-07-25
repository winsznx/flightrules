import { FlightRulesError, isErrorCode } from "@flightrules/domain";
import { type ZodType, z } from "zod";

/**
 * The API client (PRD section 12.3: the CLI "calls FlightRules API only").
 *
 * Two rules hold everywhere in this file.
 *
 * A successful transport status is not a successful call. PRD section 16 records that an
 * unmatched SigNoz path returns the single-page-application shell with HTTP 200 (SL-012); the same
 * class of mistake is possible against any HTTP surface, so every response is checked for its
 * content type and then validated against a declared schema before a single field is read.
 *
 * A failure is a typed `FlightRulesError`. The exit-code table maps codes, not strings, so a
 * network failure and a rejected contract cannot end up sharing an exit code by accident.
 */

const ErrorEnvelope = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    requestId: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
});

export interface ApiClientOptions {
  readonly baseUrl: string;
  readonly fetch: typeof globalThis.fetch;
  readonly timeoutSeconds: number;
  /** Correlates a CLI invocation with the API's own logs and with SigNoz. */
  readonly requestId?: string | undefined;
}

export class ApiClient {
  readonly #baseUrl: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #timeoutMs: number;
  readonly #requestId: string | undefined;

  constructor(options: ApiClientOptions) {
    this.#baseUrl = options.baseUrl;
    this.#fetch = options.fetch;
    this.#timeoutMs = options.timeoutSeconds * 1_000;
    this.#requestId = options.requestId;
  }

  get baseUrl(): string {
    return this.#baseUrl;
  }

  async get<T>(path: string, schema: ZodType<T>, query: Record<string, string> = {}): Promise<T> {
    const search = new URLSearchParams(query).toString();
    return this.#send("GET", search.length > 0 ? `${path}?${search}` : path, undefined, schema);
  }

  async post<T>(path: string, body: unknown, schema: ZodType<T>): Promise<T> {
    return this.#send("POST", path, body, schema);
  }

  async #send<T>(method: string, path: string, body: unknown, schema: ZodType<T>): Promise<T> {
    const url = `${this.#baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);

    let response: Response;
    try {
      response = await this.#fetch(url, {
        method,
        headers: {
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...(this.#requestId === undefined ? {} : { "x-request-id": this.#requestId }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
    } catch (cause) {
      // The URL is safe to name; the cause is not re-exposed, because a fetch failure message can
      // carry a resolved address or a proxy configuration.
      throw new FlightRulesError("SIGNOZ_UNREACHABLE", {
        message: `FlightRules could not reach its API at ${this.#baseUrl}.`,
        details: { method, path },
        cause,
      });
    } finally {
      clearTimeout(timer);
    }

    const contentType = response.headers.get("content-type") ?? "";
    const text = await response.text();

    if (!contentType.includes("application/json")) {
      throw new FlightRulesError("MCP_RESPONSE_INVALID", {
        message:
          "The API returned a non-JSON response. A status code alone is not proof a request succeeded.",
        details: { method, path, status: response.status, contentType },
      });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new FlightRulesError("MCP_RESPONSE_INVALID", {
        message: "The API returned a body that is not valid JSON.",
        details: { method, path, status: response.status },
      });
    }

    if (!response.ok) throw toTypedError(parsed, method, path, response.status);

    const validated = schema.safeParse(parsed);
    if (!validated.success) {
      throw new FlightRulesError("MCP_RESPONSE_INVALID", {
        message: "The API response did not match the schema this CLI requires.",
        details: { method, path, issues: validated.error.issues.length },
      });
    }
    return validated.data;
  }
}

/** Turns the API's typed envelope back into a typed error, so exit codes stay derived. */
function toTypedError(
  parsed: unknown,
  method: string,
  path: string,
  status: number,
): FlightRulesError {
  const envelope = ErrorEnvelope.safeParse(parsed);
  if (!envelope.success) {
    return new FlightRulesError("EVALUATION_FAILED", {
      message: `The API returned HTTP ${status} without a typed error envelope.`,
      details: { method, path, status },
    });
  }
  const { code, message, requestId } = envelope.data.error;
  return new FlightRulesError(isErrorCode(code) ? code : "EVALUATION_FAILED", {
    message,
    details: { method, path, status, requestId },
  });
}

/* -------------------------------------------------------------------------- */
/* Response schemas                                                           */
/* -------------------------------------------------------------------------- */

export const ProjectSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  defaultEnvironment: z.string(),
});

export const AgentSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  agentKey: z.string(),
  name: z.string(),
  workflowNameMatcher: z.string(),
  releaseAttributeKey: z.string(),
  environmentAttributeKey: z.string(),
});

export const ReleaseSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  releaseKey: z.string(),
  environment: z.string(),
  firstObservedAt: z.string().nullable(),
  lastObservedAt: z.string().nullable(),
});

export const pageOf = <T>(item: ZodType<T>) =>
  z.object({ items: z.array(item), nextCursor: z.string().nullable() });

export const JobSchema = z.object({
  id: z.string(),
  jobType: z.string(),
  status: z.string(),
  attempt: z.number(),
  progressStage: z.string().nullable(),
  result: z.unknown().nullable(),
  error: z.unknown().nullable(),
});

export const JobAcceptedSchema = z.object({
  jobId: z.string(),
  status: z.string(),
  created: z.boolean(),
  idempotencyKey: z.string(),
});

export const ReadinessSchema = z.object({
  status: z.enum(["ready", "not_ready"]),
  database: z.enum(["up", "down"]),
  schema: z.object({
    compatible: z.boolean(),
    applied: z.array(z.string()),
    missing: z.array(z.string()),
  }),
});

export const DependenciesSchema = z.object({
  database: z.object({ status: z.enum(["up", "down"]) }),
  signoz: z.object({
    status: z.enum(["up", "degraded", "down"]),
    missingTools: z.array(z.string()),
  }),
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
  releaseRules: z.array(
    z.object({
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
  history: z.array(
    z.object({
      evaluationId: z.string(),
      status: z.string(),
      completedAt: z.string().nullable(),
    }),
  ),
  retrievedAt: z.string(),
});

export type Gate = z.infer<typeof GateSchema>;

export const ViolationSchema = z.object({
  id: z.string(),
  ruleKey: z.string(),
  ruleType: z.string(),
  violationType: z.string(),
  severity: z.string(),
  zeroTolerance: z.boolean(),
  message: z.string(),
  expected: z.string(),
  observed: z.string(),
  traceId: z.string(),
  signozWebUrl: z.string().nullable(),
  releaseKey: z.string().nullable(),
});

export const EvaluationSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  contractId: z.string(),
  releaseId: z.string().nullable(),
  scope: z.string(),
  status: z.string(),
  summary: z.unknown(),
  completedAt: z.string().nullable(),
});
