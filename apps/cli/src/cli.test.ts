import path from "node:path";
import { fileURLToPath } from "node:url";
import { FORBIDDEN_TELEMETRY_KEYS, REDACTED } from "@flightrules/domain";
import { describe, expect, it } from "vitest";
import { parseArgs } from "./args.js";
import { run } from "./main.js";
import type { Io } from "./output.js";
import { renderGateSummary } from "./output.js";

/**
 * The CLI's contract with every pipeline that will ever run it (PRD Phase 11 tasks 5 to 7).
 *
 * `run` takes an `Io` and returns an exit code, so every path here is exercised in-process with a
 * scripted API rather than by spawning a shell. That matters most for the paths a CI system depends
 * on and a human rarely sees: an unreachable API, a non-JSON response, a schema drift.
 *
 * The one rule these tests exist to enforce: **nothing but a proven pass returns 0.**
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const CONTRACT_PATH = path.join(
  REPO_ROOT,
  "contracts/demo-commerce/refund-agent/production/contract.yaml",
);

interface Capture {
  readonly io: Io;
  readonly out: string[];
  readonly err: string[];
  readonly written: Map<string, string>;
  readonly appended: Map<string, string>;
  readonly requests: string[];
}

type Route = (url: string, init: RequestInit | undefined) => Response | Promise<Response>;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function capture(
  routes: Record<string, Route | unknown>,
  env: Record<string, string> = {},
): Capture {
  const out: string[] = [];
  const err: string[] = [];
  const written = new Map<string, string>();
  const appended = new Map<string, string>();
  const requests: string[] = [];
  // A virtual clock that only advances when the code under test sleeps. A frozen clock would make
  // every polling loop run forever, and a real one would make the timeout tests wall-clock slow.
  let clockMs = new Date("2026-07-25T12:00:00.000Z").getTime();

  const io: Io = {
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    env: { ...env },
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push(url);
      const pathname = new URL(url).pathname;
      const handler = routes[pathname];
      if (handler === undefined) {
        return json(
          {
            error: {
              code: "NOT_FOUND",
              message: `no scripted route for ${pathname}`,
              requestId: "test",
              details: {},
            },
          },
          404,
        );
      }
      return typeof handler === "function" ? (handler as Route)(url, init) : json(handler);
    }) as typeof globalThis.fetch,
    readFile: async (file) => {
      const { readFile } = await import("node:fs/promises");
      return readFile(file, "utf8");
    },
    writeFile: async (file, contents) => {
      written.set(file, contents);
    },
    appendFile: async (file, contents) => {
      appended.set(file, (appended.get(file) ?? "") + contents);
    },
    now: () => new Date(clockMs),
    sleep: async (ms) => {
      clockMs += ms;
    },
  };

  return { io, out, err, written, appended, requests };
}

const stdout = (io: Capture): string => io.out.join("");
const stderr = (io: Capture): string => io.err.join("");

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const PROJECT = {
  id: "11111111-1111-7111-8111-111111111111",
  slug: "demo-commerce",
  name: "Demo Commerce",
  defaultEnvironment: "production",
};

const AGENT = {
  id: "22222222-2222-7222-8222-222222222222",
  projectId: PROJECT.id,
  agentKey: "refund-agent",
  name: "Refund Agent",
  workflowNameMatcher: "refund-workflow",
  releaseAttributeKey: "agent.release.id",
  environmentAttributeKey: "deployment.environment.name",
};

const RELEASE = {
  id: "33333333-3333-7333-8333-333333333333",
  agentId: AGENT.id,
  releaseKey: "refund-agent-v2",
  environment: "production",
  firstObservedAt: null,
  lastObservedAt: null,
};

function gate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const decision = (overrides["decision"] as string | undefined) ?? "pass";
  const exitCode =
    (overrides["exitCode"] as number | undefined) ??
    { pass: 0, fail: 2, insufficient_data: 3, error: 4 }[decision];
  return {
    schemaVersion: "flightrules.dev/release-gate/v1",
    decision,
    exitCode,
    releaseId: RELEASE.id,
    releaseKey: RELEASE.releaseKey,
    environment: "production",
    agentId: AGENT.id,
    projectId: PROJECT.id,
    evaluationId: "44444444-4444-7444-8444-444444444444",
    evaluationStatus: "fail",
    contractId: "55555555-5555-7555-8555-555555555555",
    contractKey: "refund-agent-production",
    contractVersion: "1.0.0",
    contractContentHash: "a".repeat(64),
    contractState: "active",
    evaluatorVersion: "1.0.0",
    baselineReleaseKey: "refund-agent-v1",
    decisionHash: "b".repeat(64),
    window: { startMs: 1, endMs: 2 },
    retrieval: { truncated: false, requested: 25, returned: 25 },
    gate: {
      minCompletedRuns: 20,
      evaluationTimeoutSeconds: 600,
      maxViolationPercent: "0.5",
      maxUnknownRoutePercent: "1.0",
      maxLatencyRegressionPercent: "20",
      maxTokenRegressionPercent: "25",
      zeroToleranceRuleIds: ["require-fraud-check"],
    },
    counts: {
      evaluatedRuns: 25,
      passedRuns: 25,
      failedRuns: 0,
      erroredRuns: 0,
      insufficientRuns: 0,
      violations: 0,
      criticalViolations: 0,
      zeroToleranceViolations: 0,
      unknownRouteRuns: 0,
      duplicateSideEffectRuns: 0,
      missingPrerequisiteRuns: 0,
      degradedTraceRuns: 0,
      severities: { low: 0, medium: 0, high: 0, critical: 0 },
      observedRouteFamilies: 1,
      approvedRouteFamiliesCovered: 1,
      approvedRouteFamiliesDeclared: 1,
    },
    rates: {
      violation: { numerator: 0, denominator: 25, decimal: "0.000000", percent: "0.000000" },
      unknownRoute: { numerator: 0, denominator: 25, decimal: "0.000000", percent: "0.000000" },
      duplicateSideEffect: {
        numerator: 0,
        denominator: 25,
        decimal: "0.000000",
        percent: "0.000000",
      },
      missingPrerequisite: {
        numerator: 0,
        denominator: 25,
        decimal: "0.000000",
        percent: "0.000000",
      },
    },
    changes: {
      latency: {
        metric: "run.duration_ms",
        baseline: 100,
        candidate: 105,
        changePercent: "5.000000",
        measured: true,
      },
      tokens: {
        metric: "gen_ai.usage.total_tokens",
        baseline: null,
        candidate: null,
        changePercent: null,
        measured: false,
      },
      retries: {
        metric: "agent.retry.count",
        baseline: 0,
        candidate: 0,
        changePercent: null,
        measured: false,
      },
    },
    releaseRules: [],
    findings: [],
    disclosures: [],
    evidence: {
      representativeFailingTraceIds: [],
      representativePassingTraceIds: ["trace-a"],
      zeroToleranceRuleIds: [],
      violatedRuleIds: [],
      observedRouteFingerprints: ["sha256:aaaa"],
    },
    history: [],
    retrievedAt: "2026-07-25T12:00:00.000Z",
    ...overrides,
  };
}

const FAILING_GATE = gate({
  decision: "fail",
  counts: {
    ...(gate()["counts"] as Record<string, unknown>),
    failedRuns: 14,
    violations: 140,
    criticalViolations: 42,
    zeroToleranceViolations: 42,
  },
  rates: {
    ...(gate()["rates"] as Record<string, unknown>),
    violation: { numerator: 14, denominator: 25, decimal: "0.560000", percent: "56.000000" },
  },
  findings: [
    {
      code: "ZERO_TOLERANCE_VIOLATION",
      implies: "fail",
      severity: "critical",
      summary: "42 zero-tolerance violation(s) were observed.",
      expected: "0 zero-tolerance violation(s)",
      observed: "42 violation(s)",
      ruleId: null,
    },
  ],
  evidence: {
    representativeFailingTraceIds: ["be24d0773f0a5fa776edb9efdc8cc72a"],
    representativePassingTraceIds: [],
    zeroToleranceRuleIds: ["require-fraud-check"],
    violatedRuleIds: ["require-fraud-check", "single-refund-write"],
    observedRouteFingerprints: ["sha256:bbbb"],
  },
});

const LOOKUP_ROUTES = {
  "/api/projects": { items: [PROJECT], nextCursor: null },
  [`/api/projects/${PROJECT.id}/agents`]: { items: [AGENT], nextCursor: null },
  [`/api/agents/${AGENT.id}/releases`]: { items: [RELEASE], nextCursor: null },
};

/* -------------------------------------------------------------------------- */
/* Argument parsing                                                           */
/* -------------------------------------------------------------------------- */

describe("argument parsing", () => {
  it("recognises exactly the PRD's six commands", () => {
    // #given each PRD command name
    for (const command of [
      ["config", "verify"],
      ["contract", "validate", "x.yaml"],
      ["baseline", "capture"],
      ["release", "evaluate"],
      ["gate", "check"],
      ["evidence", "export"],
    ]) {
      // #then it parses as a command rather than as help or an error
      const parsed = parseArgs(command, {});
      expect(parsed.kind).toBe("command");
    }
  });

  it("rejects an unknown command rather than guessing", () => {
    // #then a typo fails loudly instead of running the nearest thing
    expect(() => parseArgs(["gate", "chek"], {})).toThrow(/Unknown command/);
  });

  it("rejects a non-http API URL", () => {
    // #given a file URL, which would bypass every transport control
    expect(() => parseArgs(["gate", "check", "--api-url", "file:///etc/passwd"], {})).toThrow(
      /http or https/,
    );
  });

  it("rejects an option with no value", () => {
    // #then a missing value is an error, never an empty default
    expect(() => parseArgs(["gate", "check", "--project"], {})).toThrow(/requires a value/);
  });

  it("rejects a timeout outside its bounds", () => {
    expect(() => parseArgs(["gate", "check", "--timeout", "0"], {})).toThrow(/between 1 and 3600/);
    expect(() => parseArgs(["gate", "check", "--timeout", "abc"], {})).toThrow(
      /must be an integer/,
    );
  });

  it("prefers an explicit URL over the environment", () => {
    // #given both an option and an environment variable
    const parsed = parseArgs(["gate", "check", "--api-url", "http://explicit:1"], {
      FLIGHTRULES_API_URL: "http://from-env:2",
    });

    // #then the option wins and the trailing slash handling is uniform
    expect(parsed.kind === "command" && parsed.parsed.global.apiUrl).toBe("http://explicit:1");
  });

  it("stops option parsing at --", () => {
    // #given a path that begins with a dash
    const parsed = parseArgs(["contract", "validate", "--", "--weird.yaml"], {});

    // #then it is a positional argument, not an unknown option
    expect(parsed.kind === "command" && parsed.parsed.positional).toEqual(["--weird.yaml"]);
  });
});

/* -------------------------------------------------------------------------- */
/* contract validate                                                          */
/* -------------------------------------------------------------------------- */

describe("contract validate", () => {
  it("validates the committed demo contract and exits 0", async () => {
    // #given the contract this product ships
    const io = capture({});

    // #when it is validated
    const code = await run(["contract", "validate", CONTRACT_PATH], io.io);

    // #then it is valid and its content hash is reported
    expect(code).toBe(0);
    expect(stdout(io)).toContain("valid.");
    expect(stdout(io)).toContain("content hash");
  });

  it("exits 5 for an unreadable path", async () => {
    const io = capture({});
    const code = await run(["contract", "validate", "/nonexistent/contract.yaml"], io.io);

    // #then a missing file is an invalid configuration, not an integration error
    expect(code).toBe(5);
    expect(stderr(io)).toContain("CONFIG_INVALID");
  });

  it("exits 5 for a document that is not a contract", async () => {
    const io = capture({});
    const code = await run(["contract", "validate", path.join(REPO_ROOT, "package.json")], io.io);
    expect(code).toBe(5);
  });

  it("exits 5 when no path is supplied", async () => {
    const io = capture({});
    expect(await run(["contract", "validate"], io.io)).toBe(5);
  });

  it("emits a validating JSON envelope", async () => {
    const io = capture({});
    const code = await run(["contract", "validate", CONTRACT_PATH, "--json"], io.io);
    const document = JSON.parse(stdout(io)) as Record<string, unknown>;

    // #then the envelope carries the command, the outcome and the exit code
    expect(code).toBe(0);
    expect(document["command"]).toBe("contract validate");
    expect(document["ok"]).toBe(true);
    expect(document["exitCode"]).toBe(0);
    expect(document["error"]).toBeNull();
    expect((document["result"] as Record<string, unknown>)["ruleCount"]).toBe(15);
  });
});

/* -------------------------------------------------------------------------- */
/* config verify                                                              */
/* -------------------------------------------------------------------------- */

describe("config verify", () => {
  it("exits 0 when the API is ready and its dependencies answer", async () => {
    const io = capture({
      "/health/ready": {
        status: "ready",
        database: "up",
        schema: { compatible: true, applied: ["0001", "0004"], missing: [] },
      },
      "/health/dependencies": {
        database: { status: "up" },
        signoz: { status: "up", missingTools: [] },
      },
    });

    const code = await run(["config", "verify"], io.io);
    expect(code).toBe(0);
    expect(stdout(io)).toContain("FlightRules is configured");
  });

  it("exits 0 with SigNoz degraded, which PRD section 15.1 permits", async () => {
    const io = capture({
      "/health/ready": {
        status: "ready",
        database: "up",
        schema: { compatible: true, applied: ["0001"], missing: [] },
      },
      "/health/dependencies": {
        database: { status: "up" },
        signoz: { status: "degraded", missingTools: ["signoz_update_view"] },
      },
    });

    const code = await run(["config", "verify"], io.io);
    expect(code).toBe(0);
    expect(stdout(io)).toContain("signoz_update_view");
  });

  it("exits 4 when the schema is incompatible", async () => {
    const io = capture({
      "/health/ready": {
        status: "not_ready",
        database: "up",
        schema: { compatible: false, applied: ["0001"], missing: ["0004"] },
      },
      "/health/dependencies": {
        database: { status: "up" },
        signoz: { status: "up", missingTools: [] },
      },
    });

    const code = await run(["config", "verify"], io.io);
    expect(code).toBe(4);
  });

  it("exits 4 when the API cannot be reached", async () => {
    const io = capture({});
    io.io.fetch = (() => Promise.reject(new Error("ECONNREFUSED 127.0.0.1:4000"))) as never;

    const code = await run(["config", "verify"], io.io);

    // #then the failure is typed, and the underlying error text is not echoed
    expect(code).toBe(4);
    expect(stderr(io)).toContain("SIGNOZ_UNREACHABLE");
    expect(stderr(io)).not.toContain("ECONNREFUSED");
  });
});

/* -------------------------------------------------------------------------- */
/* gate check                                                                 */
/* -------------------------------------------------------------------------- */

describe("gate check", () => {
  const withGate = (body: Record<string, unknown>) => ({
    ...LOOKUP_ROUTES,
    [`/api/releases/${RELEASE.id}/gate`]: body,
  });

  const ARGS = [
    "gate",
    "check",
    "--project",
    "demo-commerce",
    "--agent",
    "refund-agent",
    "--release",
    "refund-agent-v2",
  ];

  it("exits 0 for a passing release", async () => {
    const io = capture(withGate(gate()));
    expect(await run(ARGS, io.io)).toBe(0);
    expect(stdout(io)).toContain(
      "PASS: This release stayed within the approved trajectory contract.",
    );
  });

  it("exits 2 for a contract violation", async () => {
    const io = capture(withGate(FAILING_GATE));
    const code = await run(ARGS, io.io);

    // #then the canonical failing-canary exit code, with the PRD's own copy
    expect(code).toBe(2);
    expect(stdout(io)).toContain("FAIL: This release exceeded one or more trajectory thresholds.");
    expect(stdout(io)).toContain("ZERO_TOLERANCE_VIOLATION");
    expect(stdout(io)).toContain("be24d0773f0a5fa776edb9efdc8cc72a");
  });

  it("exits 3 for insufficient data", async () => {
    const io = capture(withGate(gate({ decision: "insufficient_data" })));
    expect(await run(ARGS, io.io)).toBe(3);
    expect(stdout(io)).toContain("INSUFFICIENT DATA");
  });

  it("exits 3 when the release has never been evaluated", async () => {
    const io = capture({
      ...LOOKUP_ROUTES,
      [`/api/releases/${RELEASE.id}/gate`]: () =>
        json(
          {
            error: {
              code: "RELEASE_INSUFFICIENT_DATA",
              message: "This release has no completed evaluation.",
              requestId: "r",
              details: {},
            },
          },
          409,
        ),
    });

    // #then an unevaluated release is undecided, never a pass
    expect(await run(ARGS, io.io)).toBe(3);
  });

  it("exits 4 for an evaluation error", async () => {
    const io = capture(withGate(gate({ decision: "error" })));
    expect(await run(ARGS, io.io)).toBe(4);
  });

  it("exits 4 when the dependency is unavailable", async () => {
    const io = capture(LOOKUP_ROUTES);
    io.io.fetch = (() => Promise.reject(new Error("connect ETIMEDOUT"))) as never;
    expect(await run(ARGS, io.io)).toBe(4);
  });

  it("exits 5 when the project cannot be identified", async () => {
    const io = capture({ "/api/projects": { items: [], nextCursor: null } });
    expect(await run(ARGS, io.io)).toBe(5);
  });

  it("exits 5 when a required option is missing", async () => {
    const io = capture(LOOKUP_ROUTES);
    expect(await run(["gate", "check"], io.io)).toBe(5);
  });

  it("refuses a 200 response that is not JSON", async () => {
    // #given the single-page-application shell served for an unmatched path (SL-012)
    const io = capture({
      ...LOOKUP_ROUTES,
      [`/api/releases/${RELEASE.id}/gate`]: () =>
        new Response("<!doctype html><html><body>SigNoz</body></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
    });

    // #then a status code alone is not treated as success
    expect(await run(ARGS, io.io)).toBe(4);
    expect(stderr(io)).toContain("MCP_RESPONSE_INVALID");
  });

  it("refuses a JSON response that does not match the schema", async () => {
    const io = capture({
      ...LOOKUP_ROUTES,
      [`/api/releases/${RELEASE.id}/gate`]: { decision: "pass" },
    });

    // #then a partially-shaped body cannot become a pass
    expect(await run(ARGS, io.io)).toBe(4);
  });

  it("refuses to report a decision when the API and the CLI disagree on the exit code", async () => {
    // #given a server claiming a violating release exits 0
    const io = capture(withGate(gate({ decision: "fail", exitCode: 0 })));

    // #then the disagreement fails the command rather than trusting the smaller number
    expect(await run(ARGS, io.io)).toBe(4);
  });

  it("emits a machine-readable document with the exit code inside it", async () => {
    const io = capture(withGate(FAILING_GATE));
    const code = await run([...ARGS, "--json"], io.io);
    const document = JSON.parse(stdout(io)) as Record<string, unknown>;

    expect(code).toBe(2);
    expect(document["ok"]).toBe(false);
    expect(document["exitCode"]).toBe(2);
    expect((document["result"] as Record<string, unknown>)["decision"]).toBe("fail");
  });

  it("writes exactly one JSON document and nothing else to stdout", async () => {
    const io = capture(withGate(gate()));
    await run([...ARGS, "--json"], io.io);

    // #then the whole of stdout parses as one document, so a pipeline can consume it
    expect(() => JSON.parse(stdout(io))).not.toThrow();
    expect(stdout(io).trimEnd().split("\n").at(-1)).toBe("}");
  });

  it("emits a typed error envelope in JSON mode when a command fails", async () => {
    const io = capture({ "/api/projects": { items: [], nextCursor: null } });
    const code = await run([...ARGS, "--json"], io.io);
    const document = JSON.parse(stdout(io)) as Record<string, unknown>;

    expect(code).toBe(5);
    expect(document["ok"]).toBe(false);
    expect((document["error"] as Record<string, unknown>)["code"]).toBe("NOT_FOUND");
  });

  it("keeps progress on stderr, out of the parsed stream", async () => {
    const io = capture(withGate(gate()));
    await run([...ARGS, "--json"], io.io);

    // #then redirecting stderr away never changes what a script reads
    expect(stderr(io)).toContain("reading the release gate");
    expect(stdout(io)).not.toContain("reading the release gate");
  });

  it("suppresses progress under --quiet without suppressing the result", async () => {
    const io = capture(withGate(gate()));
    await run([...ARGS, "--quiet"], io.io);
    expect(stderr(io)).toBe("");
    expect(stdout(io)).toContain("PASS:");
  });

  it("writes a GitHub job summary when the environment provides one", async () => {
    const io = capture(withGate(FAILING_GATE), { GITHUB_STEP_SUMMARY: "/tmp/summary.md" });
    await run(ARGS, io.io);

    const summary = io.appended.get("/tmp/summary.md") ?? "";
    expect(summary).toContain("FlightRules release gate — FAIL");
    expect(summary).toContain("Zero-tolerance violations | 42");
  });
});

/* -------------------------------------------------------------------------- */
/* release evaluate and baseline capture                                      */
/* -------------------------------------------------------------------------- */

describe("release evaluate", () => {
  const EVALUATION_ID = "44444444-4444-7444-8444-444444444444";

  const routes = (status: string) => ({
    ...LOOKUP_ROUTES,
    [`/api/agents/${AGENT.id}/contracts`]: {
      items: [
        {
          id: "55555555-5555-7555-8555-555555555555",
          status: "active",
          environment: "production",
          semanticVersion: "1.0.0",
        },
      ],
      nextCursor: null,
    },
    [`/api/agents/${AGENT.id}/evaluations`]: {
      jobId: "66666666-6666-7666-8666-666666666666",
      status: "queued",
      created: true,
      idempotencyKey: "k",
      evaluationId: EVALUATION_ID,
    },
    "/api/jobs/66666666-6666-7666-8666-666666666666": {
      id: "66666666-6666-7666-8666-666666666666",
      jobType: "evaluation",
      status: "succeeded",
      attempt: 1,
      progressStage: "evaluating_runs",
      result: { runs: 14, violations: 140 },
      error: null,
    },
    [`/api/evaluations/${EVALUATION_ID}`]: {
      id: EVALUATION_ID,
      agentId: AGENT.id,
      contractId: "55555555-5555-7555-8555-555555555555",
      releaseId: RELEASE.id,
      scope: "release",
      status,
      summary: { runs: 14, violations: 140 },
      completedAt: "2026-07-25T11:59:00.000Z",
    },
  });

  const ARGS = [
    "release",
    "evaluate",
    "--project",
    "demo-commerce",
    "--agent",
    "refund-agent",
    "--release",
    "refund-agent-v2",
  ];

  it("exits 0 for a completed evaluation even when it found violations", async () => {
    // #given an evaluation that ran and found 140 violations
    const io = capture(routes("fail"));
    const code = await run(ARGS, io.io);

    // #then "the evaluation ran" and "the release is safe" are different questions
    expect(code).toBe(0);
    expect(stdout(io)).toContain("Run `flightrules gate check`");
  });

  it("exits 3 when no runs were found", async () => {
    const io = capture(routes("insufficient_data"));
    expect(await run(ARGS, io.io)).toBe(3);
  });

  it("exits 4 when the evaluation errored", async () => {
    const io = capture(routes("error"));
    expect(await run(ARGS, io.io)).toBe(4);
  });

  it("exits 5 when the agent has no active contract", async () => {
    const io = capture({
      ...routes("pass"),
      [`/api/agents/${AGENT.id}/contracts`]: { items: [], nextCursor: null },
    });
    expect(await run(ARGS, io.io)).toBe(5);
  });

  it("exits 4 when the job fails", async () => {
    const io = capture({
      ...routes("pass"),
      "/api/jobs/66666666-6666-7666-8666-666666666666": {
        id: "66666666-6666-7666-8666-666666666666",
        jobType: "evaluation",
        status: "failed",
        attempt: 3,
        progressStage: null,
        result: null,
        error: { code: "TRACE_FETCH_FAILED", message: "SigNoz did not answer.", retryable: true },
      },
    });
    expect(await run(ARGS, io.io)).toBe(4);
  });

  it("exits 3 when the job never finishes within the timeout", async () => {
    const io = capture({
      ...routes("pass"),
      "/api/jobs/66666666-6666-7666-8666-666666666666": {
        id: "66666666-6666-7666-8666-666666666666",
        jobType: "evaluation",
        status: "running",
        attempt: 1,
        progressStage: "fetching_span_trees",
        result: null,
        error: null,
      },
    });

    // #given a clock that never advances past the deadline, the first check is already at it
    const code = await run([...ARGS, "--timeout", "1"], io.io);
    expect(code).toBe(3);
  });

  it("returns the job without waiting under --no-wait", async () => {
    const io = capture(routes("pass"));
    const code = await run([...ARGS, "--no-wait", "--json"], io.io);
    const document = JSON.parse(stdout(io)) as Record<string, unknown>;

    expect(code).toBe(0);
    expect((document["result"] as Record<string, unknown>)["waited"]).toBe(false);
  });
});

describe("baseline capture", () => {
  const ARGS = [
    "baseline",
    "capture",
    "--project",
    "demo-commerce",
    "--agent",
    "refund-agent",
    "--release",
    "refund-agent-v1",
  ];

  it("exits 3 when too few completed runs were found", async () => {
    const io = capture({
      ...LOOKUP_ROUTES,
      [`/api/agents/${AGENT.id}/baselines`]: {
        jobId: "77777777-7777-7777-8777-777777777777",
        status: "queued",
        created: true,
        idempotencyKey: "k",
      },
      "/api/jobs/77777777-7777-7777-8777-777777777777": {
        id: "77777777-7777-7777-8777-777777777777",
        jobType: "baseline_mining",
        status: "failed",
        attempt: 1,
        progressStage: null,
        result: null,
        error: {
          code: "BASELINE_INSUFFICIENT_RUNS",
          message: "Fewer completed runs were found than the baseline requires.",
          retryable: false,
        },
      },
    });

    // #then too little evidence is exit 3, distinguishable from a broken dependency
    expect(await run(ARGS, io.io)).toBe(3);
  });
});

/* -------------------------------------------------------------------------- */
/* evidence export                                                            */
/* -------------------------------------------------------------------------- */

describe("evidence export", () => {
  const ARGS = [
    "evidence",
    "export",
    "--project",
    "demo-commerce",
    "--agent",
    "refund-agent",
    "--release",
    "refund-agent-v2",
  ];

  it("writes the decision document to a file", async () => {
    const io = capture({
      ...LOOKUP_ROUTES,
      [`/api/releases/${RELEASE.id}/gate`]: FAILING_GATE,
    });

    const code = await run([...ARGS, "--out", "/tmp/evidence.json"], io.io);
    const written = io.written.get("/tmp/evidence.json") ?? "";
    const document = JSON.parse(written) as Record<string, unknown>;

    expect(code).toBe(0);
    expect(document["decision"]).toBe("fail");
    expect(
      (document["evidence"] as Record<string, unknown>)["representativeFailingTraceIds"],
    ).toEqual(["be24d0773f0a5fa776edb9efdc8cc72a"]);
  });

  it("prints the document when no output path is given", async () => {
    const io = capture({
      ...LOOKUP_ROUTES,
      [`/api/releases/${RELEASE.id}/gate`]: gate(),
    });
    expect(await run(ARGS, io.io)).toBe(0);
    expect(() => JSON.parse(stdout(io))).not.toThrow();
  });
});

/* -------------------------------------------------------------------------- */
/* Security                                                                   */
/* -------------------------------------------------------------------------- */

describe("output never leaks a secret", () => {
  it("redacts a secret-looking key that reached a result", async () => {
    // #given a gate response carrying a key the redactor must remove
    const io = capture({
      ...LOOKUP_ROUTES,
      [`/api/releases/${RELEASE.id}/gate`]: {
        ...gate(),
        history: [
          {
            evaluationId: "44444444-4444-7444-8444-444444444444",
            status: "pass",
            completedAt: null,
          },
        ],
      },
    });

    await run(
      [
        "gate",
        "check",
        "--project",
        "demo-commerce",
        "--agent",
        "refund-agent",
        "--release",
        "refund-agent-v2",
        "--json",
      ],
      io.io,
    );

    // #then nothing resembling a credential appears anywhere in the output
    const written = stdout(io) + stderr(io);
    expect(written).not.toMatch(/SIGNOZ-API-KEY/i);
    expect(written).not.toMatch(/authorization/i);
    expect(written).not.toMatch(/password/i);
  });

  it("redacts a forbidden telemetry key that reached the summary writer", () => {
    // #given a decision carrying a rule identifier that looks like a prompt attribute
    const summary = renderGateSummary(FAILING_GATE as never);

    // #then PRD section 17.6's forbidden keys never appear in a job summary
    for (const key of FORBIDDEN_TELEMETRY_KEYS) {
      expect(summary).not.toContain(key);
    }
    expect(summary).not.toContain(REDACTED);
  });

  it("does not echo an unexpected error's message", async () => {
    const io = capture(LOOKUP_ROUTES);
    io.io.fetch = (() => {
      throw new TypeError("postgres://flightrules:hunter2@localhost:5433/flightrules");
    }) as never;

    const code = await run(["config", "verify"], io.io);

    expect(code).toBe(4);
    expect(stderr(io)).not.toContain("hunter2");
  });
});

/* -------------------------------------------------------------------------- */
/* Help and version                                                           */
/* -------------------------------------------------------------------------- */

describe("help", () => {
  it("documents every command and the exit-code table", async () => {
    const io = capture({});
    const code = await run(["--help"], io.io);

    expect(code).toBe(0);
    for (const command of [
      "config verify",
      "contract validate",
      "baseline capture",
      "release evaluate",
      "gate check",
      "evidence export",
    ]) {
      expect(stdout(io)).toContain(command);
    }
    expect(stdout(io)).toContain("2  contract violation");
    expect(stdout(io)).toContain("5  invalid configuration");
  });

  it("prints the version", async () => {
    const io = capture({});
    expect(await run(["--version"], io.io)).toBe(0);
    expect(stdout(io).trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("prints usage and exits 0 with no arguments", async () => {
    const io = capture({});
    expect(await run([], io.io)).toBe(0);
    expect(stdout(io)).toContain("Usage:");
  });
});
