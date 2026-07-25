/**
 * Every literal string PRD section 8 fixes, in one module.
 *
 * PRD Phase 12's design constraints end with "UI copy must come from this PRD or a later approved
 * copy file". Keeping the copy here rather than inline in fourteen route files makes that checkable:
 * `copy.test.ts` asserts each value against the PRD's own text, so a reworded heading fails a test
 * rather than quietly changing what the product claims.
 *
 * `design.md` is authoritative for how these read — colour, size, weight — and never for what they
 * say (CLAUDE.md).
 */

export const PRODUCT_NAME = "FlightRules";

/** PRD section 8.1 — public landing route. */
export const LANDING = {
  heroEyebrow: "Trajectory reliability for AI agents",
  heroTitle: "Your agent changed its route. FlightRules caught it.",
  heroBody:
    "Turn SigNoz traces into executable release contracts. Catch skipped checks, duplicate side effects, unknown tool paths, retry loops, and behavioural drift before a canary reaches production.",
  primaryCta: "Open the live demo",
  secondaryCta: "View the architecture",
  proofStrip: [
    "OpenTelemetry-native",
    "Powered by SigNoz",
    "Deterministic release gates",
    "No chain-of-thought required",
  ],
  problemTitle: "The answer can stay correct while the agent becomes unsafe.",
  problemBody:
    "Output checks see what the agent said. FlightRules sees what it did, which tools ran, which checks disappeared, which side effects repeated, and which downstream services changed.",
  mechanismSteps: [
    "Observe real runs in SigNoz",
    "Approve known-good route families",
    "Compile them into a trajectory contract",
    "Compare every new release",
    "Fail the release with trace-level evidence",
  ],
  finalCtaTitle: "Make the execution path part of the release contract.",
  finalCtaButton: "Run the v1 vs v2 demo",
} as const;

/** PRD section 8.2 — setup route. */
export const SETUP = {
  title: "Connect FlightRules to SigNoz",
  description:
    "FlightRules reads trace evidence and creates dashboards, views, and alerts through the SigNoz MCP Server. Credentials stay on the server and are never exposed to the browser.",
  steps: [
    "Verify SigNoz URL.",
    "Verify MCP liveness and readiness.",
    "Verify API key through a read-only tool call.",
    "Discover available MCP tools.",
    "Verify OTLP ingestion endpoint.",
    "Save a server-side connection profile.",
  ],
  primaryCta: "Verify connection",
  success: "SigNoz is connected. Trace discovery and artifact creation are available.",
  failure:
    "Connection verification failed. No settings were saved. Review the failed check and retry.",
} as const;

/** PRD section 8.3 — projects route. */
export const PROJECTS = {
  title: "Projects",
  empty: "Create a project to group agents, contracts, releases, and SigNoz artifacts.",
  cta: "Create project",
} as const;

/** PRD section 8.4 — project overview. */
export const OVERVIEW = {
  titleSuffix: "trajectory health",
  cards: [
    "active agents",
    "releases evaluated",
    "gate pass rate",
    "violating runs",
    "unknown routes",
    "duplicate side effects",
    "latest contract sync",
    "SigNoz connection status",
  ],
  mainPanelTitle: "Release decisions",
  secondaryPanelTitle: "Violations by rule",
} as const;

/** PRD section 8.5 — agents list. */
export const AGENTS = {
  title: "Agents",
  empty: "Register an instrumented agent, then capture a known-good baseline from SigNoz.",
  cta: "Register agent",
} as const;

/** PRD section 8.6 — agent detail. */
export const AGENT_DETAIL = {
  tabs: ["Overview", "Routes", "Contracts", "Releases", "Violations", "Telemetry"],
  ctaNoBaseline: "Capture baseline",
  ctaWithBaseline: "Evaluate release",
} as const;

/** PRD section 8.7 — baseline capture. */
export const BASELINE = {
  title: "Capture a known-good baseline",
  description:
    "Select a release and time window. FlightRules will fetch complete traces from SigNoz, normalise their topology, group route families, and propose a contract for review.",
  controls: [
    "release ID",
    "environment",
    "time range",
    "minimum completed runs",
    "include successful runs only toggle",
    "exclude traces with missing root span toggle",
    "rare route threshold",
    "maximum traces to fetch",
  ],
  primaryCta: "Analyse baseline",
  progressStates: [
    "Discovering traces",
    "Fetching complete span trees",
    "Normalising routes",
    "Grouping route families",
    "Proposing contract rules",
  ],
} as const;

/** PRD section 8.8 — route family detail. */
export const ROUTE_FAMILY = {
  titlePrefix: "Route family",
  sections: [
    "occurrence count",
    "share of baseline runs",
    "first and last observed",
    "canonical graph",
    "representative traces",
    "tools and services used",
    "side-effecting operations",
    "retries",
    "latency distribution",
    "token distribution when available",
  ],
  actions: ["Approve", "Reject", "Mark optional", "Exclude as fixture error"],
} as const;

/** PRD section 8.9 — Contract Studio. */
export const CONTRACT_STUDIO = {
  title: "Trajectory contract",
  statuses: ["Draft", "Approved", "Active", "Superseded", "Invalid"],
  actions: [
    "Validate contract",
    "Approve version",
    "Sync to SigNoz",
    "Export YAML",
    "Evaluate against traces",
  ],
  graphNodeRuleControls: [
    "Required",
    "Optional",
    "Forbidden",
    "Maximum calls",
    "Must precede",
    "Must descend from",
    "Side effect",
    "Sensitive data domain",
  ],
  unsavedWarning: "This contract has unvalidated changes. Validate it before approval.",
} as const;

/** PRD section 8.10 — releases list. */
export const RELEASES = {
  title: "Releases",
  columns: [
    "release ID",
    "commit SHA",
    "environment",
    "first observed",
    "evaluated runs",
    "gate decision",
    "violation rate",
    "unknown route rate",
    "latency change",
    "token change",
  ],
} as const;

/** PRD section 8.11 — Release Diff. */
export const RELEASE_DIFF = {
  decision: {
    pass: "PASS: This release stayed within the approved trajectory contract.",
    fail: "FAIL: This release exceeded one or more trajectory thresholds.",
    insufficient_data:
      "INSUFFICIENT DATA: More completed runs are required before a release decision can be made.",
    error:
      "ERROR: FlightRules could not complete the evaluation. No release decision was produced.",
  },
  diffLabels: [
    "Added step",
    "Removed step",
    "New edge",
    "Missing edge",
    "Cardinality changed",
    "New tool",
    "New service",
    "New data domain",
    "Retry increase",
    "Latency regression",
    "Token regression",
    "Duplicate side effect",
  ],
  actions: [
    "Open representative violation",
    "Re-run evaluation",
    "Download evidence",
    "Open in SigNoz",
  ],
} as const;

/** PRD section 8.12 — Violation Inspector. */
export const VIOLATION = {
  titleSuffix: "violated",
  sections: [
    "What failed",
    "Observed route",
    "Approved route",
    "Trace evidence",
    "Correlated logs",
    "Downstream metrics",
    "Release context",
    "Rule definition",
    "Evaluation record",
  ],
  primaryCta: "Open trace in SigNoz",
  secondaryActions: ["Open correlated logs", "Inspect release diff", "Copy evidence summary"],
  /**
   * PRD section 8.12: "The product must never offer `Ignore and pass release`." A route test
   * asserts this string is absent from every rendered page, so the prohibition is enforced rather
   * than merely respected.
   */
  forbiddenAction: "Ignore and pass release",
} as const;

/** PRD section 8.13 — SigNoz integration route. */
export const INTEGRATION = {
  title: "SigNoz integration",
  sections: [
    "connection status",
    "discovered tool capabilities",
    "telemetry field discovery",
    "managed dashboards",
    "managed alerts",
    "managed views",
    "notification channels",
    "sync history",
  ],
  actions: ["Verify connection", "Discover fields", "Sync artifacts", "Open SigNoz"],
} as const;

/** PRD section 8.14 — demo route. */
export const DEMO = {
  title: "The answer stayed correct. The route did not.",
  controls: ["Run approved v1", "Run unsafe v2", "Capture baseline", "Evaluate v2", "Reset demo"],
  sameAnswerNote:
    "The demo page must show the same customer-facing answer for both releases before revealing the trace difference.",
} as const;

/** Shared state copy, used by every route that fetches. */
export const STATES = {
  loading: "Loading",
  apiUnreachableTitle: "FlightRules could not reach its API.",
  apiUnreachableBody:
    "The web application talks only to the FlightRules API. Start it with `make api` and reload.",
  notFoundTitle: "That resource does not exist.",
  notFoundBody: "It may have been deleted, or the identifier in the address may be wrong.",
  degradedTitle: "SigNoz is degraded.",
  degradedBody:
    "Stored evidence is still readable. Trace discovery and artifact creation are unavailable until the connection recovers.",
} as const;
