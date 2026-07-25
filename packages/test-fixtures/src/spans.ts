/**
 * Span-row builder for tests that need a topology the demo does not emit.
 *
 * The two captured traces are real telemetry and stay the primary evidence for anything the demo
 * actually does. But a contract has eleven rule types and the demo legitimately never violates most
 * of them — there is no admin write, no unknown tool, no orphan span and no cycle in a healthy
 * refund. Those cases still have to be proven, so they are built here.
 *
 * The rows produced carry exactly the key set the SigNoz Query Builder returns for the real fixtures,
 * including the ISO-8601 `timestamp` at millisecond precision that SL-044 recorded, so a built row
 * travels the same code path as a captured one. A builder that emitted a tidier shape would test a
 * parser the product does not have.
 */

export interface SpanSpec {
  readonly name: string;
  readonly spanId: string;
  readonly parentSpanId?: string | null;
  readonly service?: string;
  readonly kind?: "Server" | "Client" | "Internal";
  readonly tool?: string | null;
  readonly operation?: string | null;
  readonly sideEffect?: "none" | "read" | "write" | "external" | "unknown" | null;
  readonly dataDomain?: string | null;
  readonly stepCategory?: string | null;
  readonly retry?: number | null;
  readonly durationNano?: number;
  readonly startOffsetMs?: number;
  readonly idempotencyPresent?: boolean | null;
  readonly statusCode?: string;
  /** Extra attributes, or an override of any generated one. `null` removes the key entirely. */
  readonly attributes?: Readonly<Record<string, unknown>>;
}

export interface TraceSpec {
  readonly traceId: string;
  readonly releaseId?: string;
  readonly runId?: string;
  readonly environment?: string;
  /** Base instant the offsets are measured from. Explicit, so no test reads the clock. */
  readonly startedAtUtc?: string;
  readonly spans: readonly SpanSpec[];
}

const DEFAULT_STARTED_AT = "2026-07-25T10:00:00.000Z";

/**
 * Builds Query Builder rows.
 *
 * Rows are returned sorted by span ID — deliberately not in tree order, matching how the capture
 * script stores the real fixtures, so a builder that depended on arrival order would fail at once.
 */
export function spanRows(spec: TraceSpec): readonly Record<string, unknown>[] {
  const releaseId = spec.releaseId ?? "refund-agent-v1";
  const runId = spec.runId ?? "run_0000000000000000test";
  const environment = spec.environment ?? "local";
  const baseMs = Date.parse(spec.startedAtUtc ?? DEFAULT_STARTED_AT);

  const rows = spec.spans.map((span, position) => {
    const offsetMs = span.startOffsetMs ?? position;
    const row: Record<string, unknown> = {
      trace_id: spec.traceId,
      span_id: span.spanId,
      parent_span_id: span.parentSpanId ?? "",
      name: span.name,
      kind_string: span.kind ?? "Client",
      "service.name": span.service ?? "flightrules-demo-agent",
      duration_nano: span.durationNano ?? 1_000_000,
      timestamp: new Date(baseMs + offsetMs).toISOString(),
      status_code_string: span.statusCode ?? "Ok",
      has_error: false,
      "agent.release.id": releaseId,
      "agent.run.id": runId,
      "deployment.environment.name": environment,
      "agent.side_effect": span.sideEffect ?? "none",
      "agent.data_domain": span.dataDomain ?? null,
      "agent.step.category": span.stepCategory ?? null,
      "agent.retry.number": span.retry ?? null,
      "agent.idempotency.present": span.idempotencyPresent ?? null,
      "gen_ai.tool.name": span.tool ?? null,
      "gen_ai.operation.name": span.operation ?? null,
    };

    // Explicit overrides last, so a test can both add an attribute and delete a generated one.
    for (const [key, value] of Object.entries(span.attributes ?? {})) {
      if (value === null) delete row[key];
      else row[key] = value;
    }

    return row;
  });

  return [...rows].sort((a, b) => {
    const left = String(a["span_id"]);
    const right = String(b["span_id"]);
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

/**
 * The approved refund topology, as span specs, ready to be modified.
 *
 * Mirrors the real v1 trace: a workflow root, six client steps each in the agent, and a server
 * handler for the five that make a remote call. `refund.calculate` has no handler because it is local
 * agent work — the same asymmetry the real trace has.
 */
export function approvedRefundSpans(): readonly SpanSpec[] {
  return [
    {
      name: "refund.request",
      spanId: "root0000",
      parentSpanId: null,
      kind: "Server",
      operation: "invoke_agent",
      stepCategory: "workflow",
    },
    {
      name: "policy.retrieve",
      spanId: "c1policy",
      parentSpanId: "root0000",
      tool: "retrieve_policy",
      operation: "execute_tool",
      sideEffect: "read",
      dataDomain: "policy",
      stepCategory: "policy",
      retry: 0,
    },
    {
      name: "policy.retrieve.handler",
      spanId: "s1policy",
      parentSpanId: "c1policy",
      kind: "Server",
      service: "flightrules-policy-service",
      sideEffect: "read",
      dataDomain: "policy",
      stepCategory: "policy",
    },
    {
      name: "order.lookup",
      spanId: "c2order0",
      parentSpanId: "root0000",
      tool: "lookup_order",
      operation: "execute_tool",
      sideEffect: "read",
      dataDomain: "orders",
      stepCategory: "order",
      retry: 0,
    },
    {
      name: "order.lookup.handler",
      spanId: "s2order0",
      parentSpanId: "c2order0",
      kind: "Server",
      service: "flightrules-order-service",
      sideEffect: "read",
      dataDomain: "orders",
      stepCategory: "order",
    },
    {
      name: "fraud.check",
      spanId: "c3fraud0",
      parentSpanId: "root0000",
      tool: "check_fraud",
      operation: "execute_tool",
      sideEffect: "read",
      dataDomain: "fraud",
      stepCategory: "fraud",
      retry: 0,
    },
    {
      name: "fraud.check.handler",
      spanId: "s3fraud0",
      parentSpanId: "c3fraud0",
      kind: "Server",
      service: "flightrules-fraud-service",
      sideEffect: "read",
      dataDomain: "fraud",
      stepCategory: "fraud",
    },
    {
      name: "refund.calculate",
      spanId: "c4calcul",
      parentSpanId: "root0000",
      tool: "calculate_refund",
      operation: "execute_tool",
      sideEffect: "none",
      dataDomain: "refund",
      stepCategory: "refund",
      retry: 0,
    },
    {
      name: "payment.refund",
      spanId: "c5paymnt",
      parentSpanId: "root0000",
      tool: "issue_refund",
      operation: "execute_tool",
      sideEffect: "write",
      dataDomain: "payments",
      stepCategory: "payment",
      retry: 0,
      idempotencyPresent: true,
    },
    {
      name: "payment.refund.handler",
      spanId: "s5paymnt",
      parentSpanId: "c5paymnt",
      kind: "Server",
      service: "flightrules-payment-service",
      sideEffect: "write",
      dataDomain: "payments",
      stepCategory: "payment",
      retry: 0,
      idempotencyPresent: true,
    },
    {
      name: "customer.notify",
      spanId: "c6notify",
      parentSpanId: "root0000",
      tool: "notify_customer",
      operation: "execute_tool",
      sideEffect: "external",
      dataDomain: "messaging",
      stepCategory: "customer",
      retry: 0,
    },
    {
      name: "customer.notify.handler",
      spanId: "s6notify",
      parentSpanId: "c6notify",
      kind: "Server",
      service: "flightrules-notification-service",
      sideEffect: "external",
      dataDomain: "messaging",
      stepCategory: "customer",
    },
  ];
}

/** Convenience: the approved topology as rows, optionally with spans replaced, added or removed. */
export function approvedRefundRows(
  changes: {
    readonly traceId?: string;
    readonly remove?: readonly string[];
    readonly add?: readonly SpanSpec[];
    readonly replace?: readonly SpanSpec[];
  } = {},
): readonly Record<string, unknown>[] {
  const removed = new Set(changes.remove ?? []);
  const replacements = new Map((changes.replace ?? []).map((span) => [span.spanId, span]));

  const spans = approvedRefundSpans()
    .filter((span) => !removed.has(span.spanId))
    .map((span) => replacements.get(span.spanId) ?? span);

  return spanRows({
    traceId: changes.traceId ?? "trace000000000000000000000000test",
    spans: [...spans, ...(changes.add ?? [])],
  });
}

/**
 * Rewrites a captured trace into a distinct logical run.
 *
 * Baseline mining needs many runs of one route, and the only honest way to produce them from captured
 * telemetry is to change exactly what varies between two runs of identical behaviour: the trace
 * identifier, the span identifiers, the run identifier, the start time and the duration. Everything a
 * route fingerprint is computed from is left untouched, so a renumbered run must land in the same
 * route family — which is the property the mining tests assert rather than assume.
 *
 * Span identifiers are rewritten by a stable mapping rather than by string concatenation, so the
 * parent relation survives and no two spans can collide.
 */
export function renumberTrace(
  rows: readonly Record<string, unknown>[],
  change: {
    readonly traceId: string;
    readonly runId: string;
    readonly startedAtUtc: string;
    /** Applied to the root span only, since the run duration is measured from the root. */
    readonly rootDurationNano?: number;
  },
): readonly Record<string, unknown>[] {
  const spanIds = [
    ...new Set(rows.map((row) => String(row["span_id"] ?? "")).filter((id) => id.length > 0)),
  ].sort();
  const rewritten = new Map(
    spanIds.map((spanId, index) => [
      spanId,
      `${change.traceId.slice(0, 8)}${String(index).padStart(8, "0")}`,
    ]),
  );
  const baseMs = Date.parse(change.startedAtUtc);

  const originalStart = Math.min(
    ...rows.map((row) => {
      const value = row["timestamp"];
      return typeof value === "string" ? Date.parse(value) : Number.NaN;
    }),
  );

  return rows.map((row) => {
    const parent = String(row["parent_span_id"] ?? "");
    const timestamp = row["timestamp"];
    const offsetMs =
      typeof timestamp === "string" && Number.isFinite(originalStart)
        ? Date.parse(timestamp) - originalStart
        : 0;

    return {
      ...row,
      trace_id: change.traceId,
      span_id: rewritten.get(String(row["span_id"])) ?? row["span_id"],
      parent_span_id: parent.length === 0 ? "" : (rewritten.get(parent) ?? ""),
      "agent.run.id": change.runId,
      timestamp: new Date(baseMs + offsetMs).toISOString(),
      ...(change.rootDurationNano === undefined || parent.length > 0
        ? {}
        : { duration_nano: change.rootDurationNano }),
    };
  });
}

/** A chain of `depth` spans, for depth and performance tests. */
export function deepChainRows(
  depth: number,
  traceId = "deepchain00000000000000000000000",
): readonly Record<string, unknown>[] {
  const spans: SpanSpec[] = [
    {
      name: "refund.request",
      spanId: "span000000",
      parentSpanId: null,
      kind: "Server",
      operation: "invoke_agent",
    },
  ];
  for (let level = 1; level < depth; level += 1) {
    spans.push({
      name: `step.level`,
      spanId: `span${String(level).padStart(6, "0")}`,
      parentSpanId: `span${String(level - 1).padStart(6, "0")}`,
      tool: "step_tool",
      operation: "execute_tool",
      sideEffect: "read",
      retry: 0,
    });
  }
  return spanRows({ traceId, spans });
}

/** A wide trace: one root with `width` children, for performance tests. */
export function wideTraceRows(
  width: number,
  traceId = "widetrace00000000000000000000000",
): readonly Record<string, unknown>[] {
  const spans: SpanSpec[] = [
    {
      name: "refund.request",
      spanId: "span000000",
      parentSpanId: null,
      kind: "Server",
      operation: "invoke_agent",
    },
  ];
  for (let index = 1; index <= width; index += 1) {
    spans.push({
      name: `step.${index % 17}`,
      spanId: `span${String(index).padStart(6, "0")}`,
      parentSpanId: "span000000",
      tool: `tool_${index % 11}`,
      operation: "execute_tool",
      sideEffect: index % 5 === 0 ? "write" : "read",
      dataDomain: `domain_${index % 7}`,
      retry: index % 3,
    });
  }
  return spanRows({ traceId, spans });
}
