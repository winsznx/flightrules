import { readFileSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "./deployment.js";

/**
 * Real trace fixtures, captured from the live SigNoz deployment by
 * `scripts/capture-trace-fixtures.mjs`.
 *
 * These are actual telemetry emitted by the instrumented demo topology, not hand-written JSON.
 * The graph engine's whole job is to normalise real volatile identifiers away and reconstruct
 * real causal structure, and a fixture invented to match the implementation would prove neither.
 */

export interface TraceFixture {
  readonly capturedAtUtc: string;
  readonly releaseId: string;
  readonly traceId: string;
  readonly source: string;
  readonly spanCount: number;
  readonly rows: readonly { readonly data: Record<string, unknown> }[];
}

const TRACE_DIR = path.join(REPO_ROOT, "packages", "test-fixtures", "traces");

function load(name: string): TraceFixture {
  return JSON.parse(readFileSync(path.join(TRACE_DIR, name), "utf8")) as TraceFixture;
}

/** The approved route: policy, order lookup, fraud, calculate, one refund, notify. */
export function knownGoodTrace(): TraceFixture {
  return load("refund-agent-v1.json");
}

/** The unsafe canary: policy and fraud skipped, the refund issued twice. */
export function unsafeTrace(): TraceFixture {
  return load("refund-agent-v2.json");
}

/** The span-row shape the graph builder consumes. */
export function rowsOf(fixture: TraceFixture): readonly Record<string, unknown>[] {
  return fixture.rows.map((row) => row.data);
}
