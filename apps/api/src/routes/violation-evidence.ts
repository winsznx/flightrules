import { findAgent, findProject, findViolation } from "@flightrules/db";
import { FlightRulesError } from "@flightrules/domain";
import { METRIC_NAMES } from "@flightrules/telemetry";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { notFound, requireUuid } from "../http.js";
import type { RouteRegistry } from "../registry.js";

/**
 * Correlated logs and downstream metrics for one violation (PRD Phase 15 tasks 5 and 6, PRD
 * section 8.12).
 *
 * Two reads, both **on request**. PRD Phase 15 says "correlated logs fetched through MCP when
 * requested", and that is load-bearing rather than a performance choice: an inspector page that
 * always calls SigNoz cannot render at all when SigNoz is down, and the violation evidence — which
 * is entirely local, persisted and already proven — would become unreachable because of a
 * dependency it does not need. Fetching on request is what makes
 * "failed log or metric fetch degrades without hiding the core violation" true by construction.
 *
 * Neither route can fail the page. Every failure mode PRD Phase 15 lists — zero results,
 * unavailable, malformed, timeout, typed-field mismatch, partial, truncated — is returned as HTTP
 * 200 with a typed `state` and an empty result set. The caller renders a panel that says what
 * happened; nothing throws.
 *
 * Correlation is by the **trace identifier the evaluator recorded**, never by a time window or a
 * service name, either of which would attach another run's evidence to this violation.
 */

const LOG_STATES = ["ok", "empty", "unavailable", "malformed", "timeout", "truncated"] as const;

const LogsResponse = z.object({
  violationId: z.string(),
  traceId: z.string(),
  state: z.enum(LOG_STATES),
  /** Present on any state but `ok`; one safe sentence, never a dependency's raw text. */
  detail: z.string().nullable(),
  windowStartMs: z.number(),
  windowEndMs: z.number(),
  requestedLimit: z.number(),
  logs: z.array(
    z.object({
      timestamp: z.string().nullable(),
      severity: z.string().nullable(),
      service: z.string().nullable(),
      body: z.string(),
    }),
  ),
});

const METRIC_KINDS = ["measured", "observed_side_effect", "inferred_risk", "unavailable"] as const;

const MetricsResponse = z.object({
  violationId: z.string(),
  state: z.enum(["ok", "empty", "unavailable", "malformed", "timeout"]),
  detail: z.string().nullable(),
  windowStartMs: z.number(),
  windowEndMs: z.number(),
  series: z.array(
    z.object({
      metric: z.string(),
      /**
       * What this number is, which matters more than the number.
       *
       * `measured` — FlightRules recorded it. `observed_side_effect` — the evaluator counted it in
       * the trace. `inferred_risk` — a consequence the telemetry makes plausible and does not
       * prove. `unavailable` — no series exists. PRD Phase 15 forbids a fabricated financial-loss
       * figure and forbids inferring business effect telemetry does not show, so the distinction is
       * part of the response rather than a caption on a page.
       */
      kind: z.enum(METRIC_KINDS),
      summary: z.string(),
      points: z.array(
        z.object({
          value: z.number().nullable(),
          timestamp: z.string().nullable(),
          labels: z.record(z.string(), z.string()),
        }),
      ),
    }),
  ),
});

/** How far either side of the violation to look. Bounded so a query cannot become a scan. */
const WINDOW_MS = 60 * 60 * 1000;
const LOG_LIMIT = 100;

/** SigNoz trace identifiers are 32 lowercase hex characters. Anything else is never sent. */
const TRACE_ID = /^[0-9a-f]{32}$/;

/** Maps a thrown FlightRules error onto the typed degraded state the page renders. */
function degradedState(error: unknown): {
  state: "unavailable" | "malformed" | "timeout";
  detail: string;
} {
  const code = error instanceof FlightRulesError ? error.code : "MCP_UNAVAILABLE";
  switch (code) {
    case "SIGNOZ_UNREACHABLE":
      return {
        state: "unavailable",
        detail: "SigNoz could not be reached. The violation evidence above is unaffected.",
      };
    case "MCP_RESPONSE_INVALID":
      return {
        state: "malformed",
        detail: "SigNoz returned a response FlightRules could not read.",
      };
    case "TRACE_QUERY_FAILED":
      return {
        state: "malformed",
        detail: "SigNoz rejected the query. This is usually a field the workspace does not define.",
      };
    default:
      return {
        state: "unavailable",
        detail: "The SigNoz connection is unavailable. The violation evidence above is unaffected.",
      };
  }
}

export function registerViolationEvidenceRoutes(
  server: FastifyInstance,
  registry: RouteRegistry,
  context: AppContext,
): void {
  const { sql } = context;

  registry.add(
    server,
    {
      method: "GET",
      url: "/api/violations/:violationId/logs",
      summary:
        "Logs correlated to a violation's trace, fetched through SigNoz MCP on request. Every failure mode returns a typed degraded state rather than an error.",
      tag: "violations",
      response: LogsResponse,
      errors: [],
    },
    async ({ params }) => {
      const id = requireUuid(params["violationId"] ?? "", "violation");
      const violation = await findViolation(sql, id);
      if (!violation) throw notFound("violation", id);

      const evaluatedAt = violation.evaluatedAt ?? violation.createdAt;
      const windowEndMs = evaluatedAt.getTime() + WINDOW_MS;
      const windowStartMs = evaluatedAt.getTime() - WINDOW_MS;

      const base = {
        violationId: violation.id,
        traceId: violation.traceId,
        windowStartMs,
        windowEndMs,
        requestedLimit: LOG_LIMIT,
      };

      // A trace identifier that is not one is never sent to SigNoz. A malformed value in the
      // database is a data problem, not a reason to interpolate it into a filter expression.
      if (!TRACE_ID.test(violation.traceId)) {
        return {
          ...base,
          state: "malformed" as const,
          detail: "This violation's trace identifier is not a well-formed SigNoz trace ID.",
          logs: [],
        };
      }

      const gateway = context.gateway();
      try {
        const logs = await gateway.searchLogs({
          traceId: violation.traceId,
          startMs: windowStartMs,
          endMs: windowEndMs,
          limit: LOG_LIMIT,
        });

        if (logs.length === 0) {
          return {
            ...base,
            state: "empty" as const,
            detail:
              "SigNoz holds no log correlated to this trace. FlightRules writes structured logs to stdout; exporting them over OTLP is not yet enabled, so an empty result here is expected rather than surprising.",
            logs: [],
          };
        }

        // A full page is reported as truncated rather than presented as everything there is.
        return {
          ...base,
          state: logs.length >= LOG_LIMIT ? ("truncated" as const) : ("ok" as const),
          detail:
            logs.length >= LOG_LIMIT
              ? `Showing the first ${String(LOG_LIMIT)} log lines. There may be more.`
              : null,
          logs: [...logs],
        };
      } catch (error: unknown) {
        const degraded = degradedState(error);
        return { ...base, state: degraded.state, detail: degraded.detail, logs: [] };
      } finally {
        await gateway.close().catch(() => {});
      }
    },
  );

  registry.add(
    server,
    {
      method: "GET",
      url: "/api/violations/:violationId/metrics",
      summary:
        "Downstream metric evidence associated with a violation, distinguishing measured effect from observed side effect, inferred risk and unavailable.",
      tag: "violations",
      response: MetricsResponse,
      errors: [],
    },
    async ({ params }) => {
      const id = requireUuid(params["violationId"] ?? "", "violation");
      const violation = await findViolation(sql, id);
      if (!violation) throw notFound("violation", id);

      const agent = await findAgent(sql, violation.agentId);
      const project = agent === null ? null : await findProject(sql, agent.projectId);

      const evaluatedAt = violation.evaluatedAt ?? violation.createdAt;
      const windowEndMs = evaluatedAt.getTime() + WINDOW_MS;
      const windowStartMs = evaluatedAt.getTime() - WINDOW_MS;
      const base = { violationId: violation.id, windowStartMs, windowEndMs };

      /**
       * Which metric answers "what did this actually cause".
       *
       * Only the series FlightRules itself emits (PRD section 17.4). There is deliberately no
       * business metric here: PRD Phase 15 forbids a fabricated financial-loss number and forbids
       * inferring an effect the telemetry does not prove, and a refund ledger is the demo's, not
       * the product's.
       */
      const metric =
        violation.violationType === "duplicate_side_effect" || violation.ruleType === "cardinality"
          ? {
              name: METRIC_NAMES.duplicateSideEffects,
              kind: "observed_side_effect" as const,
              summary:
                "Runs in which the evaluator counted a side-effecting step more times than the approved route performs it. This is a count of observed repetitions, not a measure of their cost.",
            }
          : {
              name: METRIC_NAMES.violations,
              kind: "measured" as const,
              summary:
                "Violations FlightRules recorded while evaluating this release, by rule and severity.",
            };

      if (project === null || agent === null) {
        return {
          ...base,
          state: "unavailable" as const,
          detail: "This violation's project or agent no longer exists, so no metric can be scoped.",
          series: [],
        };
      }

      // Grouped by the FlightRules dimensions rather than filtered on them. SL-062 records why: the
      // series this deployment holds carry those dimension names with **empty values**, so a filter
      // on them matches nothing while the underlying data is real. Grouping returns the data and
      // makes the missing scope visible in the labels, which is the honest presentation of a metric
      // FlightRules cannot currently narrow to one agent.
      const groupBy = ["flight_rules.project.id", "flight_rules.agent.id"];

      const gateway = context.gateway();
      try {
        const points = await gateway.queryMetrics({
          metricName: metric.name,
          startMs: windowStartMs,
          endMs: windowEndMs,
          groupBy,
        });

        if (points.length === 0) {
          return {
            ...base,
            state: "empty" as const,
            detail: `SigNoz reports no ${metric.name} series in this window.`,
            series: [
              {
                metric: metric.name,
                kind: "unavailable" as const,
                summary: metric.summary,
                points: [],
              },
            ],
          };
        }

        // Whether the series is actually scoped to this agent, or is the deployment's.
        const scoped = points.some(
          (point) => (point.labels["flight_rules.agent.id"] ?? "") === agent.id,
        );

        return {
          ...base,
          state: "ok" as const,
          detail: scoped
            ? null
            : "This series is not narrowed to this agent: the metric carries the FlightRules project and agent dimensions with empty values in this deployment, so what is shown is the deployment-wide series for this metric.",
          series: [
            {
              metric: metric.name,
              kind: metric.kind,
              summary: metric.summary,
              points: points.map((point) => ({
                value: point.value,
                timestamp: point.timestamp,
                labels: point.labels,
              })),
            },
          ],
        };
      } catch (error: unknown) {
        const degraded = degradedState(error);
        return { ...base, state: degraded.state, detail: degraded.detail, series: [] };
      } finally {
        await gateway.close().catch(() => {});
      }
    },
  );
}
