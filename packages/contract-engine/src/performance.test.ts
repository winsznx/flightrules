import { readFileSync } from "node:fs";
import path from "node:path";
import {
  formatValidationErrors,
  parseContract,
  type TrajectoryContract,
} from "@flightrules/contract-schema";
import {
  deepChainRows,
  knownGoodTrace,
  rowsOf,
  unsafeTrace,
  wideTraceRows,
} from "@flightrules/test-fixtures";
import {
  buildTraceGraph,
  canonicaliseGraph,
  fingerprintGraph,
  type TraceGraph,
} from "@flightrules/trace-graph";
import { describe, expect, it } from "vitest";
import { evaluateRun } from "./evaluate.js";
import { GraphIndex } from "./graph-index.js";
import type { ApprovedRoute } from "./rule-context.js";

/**
 * Performance budgets.
 *
 * PRD section 20.2 sets the targets these check. They exist to stop a silent regression, which is why
 * each budget is generous relative to the measured figure — a test tuned to the current number fails
 * on a slower machine and gets deleted, and then nothing is measured at all. The Phase 06 experience
 * is the precedent: a quadratic canonical path took 5.6 seconds and only a budget caught it.
 */

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const DEMO_CONTRACT = path.join(
  REPO_ROOT,
  "contracts",
  "demo-commerce",
  "refund-agent",
  "production",
  "contract.yaml",
);
const FIXTURE_DIR = path.join(REPO_ROOT, "packages", "contract-engine", "fixtures", "contracts");
const ROOT_SELECTOR = "refund.request";

function demoContract(): TrajectoryContract {
  const result = parseContract(readFileSync(DEMO_CONTRACT, "utf8"));
  if (!result.ok) throw new Error(formatValidationErrors(result.errors));
  return result.value.contract;
}

/** The demo contract widened to the maximum permitted rule count. */
function maximalContract(): TrajectoryContract {
  const base = demoContract();
  const filler = Array.from({ length: 500 - base.spec.rules.length }, (_, index) => ({
    id: `filler-${String(index).padStart(4, "0")}`,
    type: "forbidden_span" as const,
    severity: "low" as const,
    selector: { name: `never.happens.${index}` },
  }));
  return { ...base, spec: { ...base.spec, rules: [...base.spec.rules, ...filler] } };
}

function graphOf(rows: readonly Record<string, unknown>[]): TraceGraph {
  return buildTraceGraph(rows, { rootSelector: ROOT_SELECTOR, maxSpans: 20_000 });
}

function approvedFamily(graph: TraceGraph): readonly ApprovedRoute[] {
  return [
    { fingerprint: fingerprintGraph(graph).fingerprint, canonical: canonicaliseGraph(graph) },
  ];
}

/** Median of several runs, so one scheduling hiccup does not decide the verdict. */
function medianMs(iterations: number, run: () => void): number {
  const samples: number[] = [];
  for (let index = 0; index < iterations; index += 1) {
    const started = process.hrtime.bigint();
    run();
    samples.push(Number(process.hrtime.bigint() - started) / 1e6);
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)] as number;
}

describe("evaluator performance", () => {
  it("evaluates the demo canary well inside the 250 ms p95 target for a 100-span trace", () => {
    // #given the real 8-span canary trace and the 15-rule active contract
    const graph = graphOf(rowsOf(unsafeTrace()));
    const contract = demoContract();
    const approved = approvedFamily(graphOf(rowsOf(knownGoodTrace())));

    const elapsed = medianMs(20, () => {
      evaluateRun({ graph, contract, approvedRoutes: approved });
    });

    // #then PRD section 20.2's budget is met with a wide margin
    expect(elapsed).toBeLessThan(250);
  });

  it("evaluates a 1,000-span trace against all eleven rule types within a second", () => {
    const graph = graphOf(wideTraceRows(999));
    const contract = demoContract();
    const approved = approvedFamily(graph);

    const elapsed = medianMs(5, () => {
      evaluateRun({ graph, contract, approvedRoutes: approved });
    });

    expect(elapsed).toBeLessThan(1_000);
  });

  it("evaluates a 10,000-span trace without degrading superlinearly", () => {
    // #given a wide trace an order of magnitude larger
    const small = graphOf(wideTraceRows(999));
    const large = graphOf(wideTraceRows(9_999));
    const contract = demoContract();

    const smallMs = medianMs(3, () => {
      evaluateRun({ graph: small, contract, approvedRoutes: approvedFamily(small) });
    });
    const largeMs = medianMs(3, () => {
      evaluateRun({ graph: large, contract, approvedRoutes: approvedFamily(large) });
    });

    // #then ten times the spans costs far less than a hundred times the work. A quadratic evaluator
    // would land near 100x; the allowance of 40x leaves room for cache effects and constant factors
    // while still failing loudly on an accidental nested scan.
    expect(largeMs).toBeLessThan(Math.max(smallMs * 40, 250));
    expect(largeMs).toBeLessThan(10_000);
  });

  it("evaluates the maximum permitted rule count on a 1,000-span trace within two seconds", () => {
    // #given 500 rules, the DSL's ceiling
    const graph = graphOf(wideTraceRows(999));
    const contract = maximalContract();
    expect(contract.spec.rules).toHaveLength(500);

    const elapsed = medianMs(3, () => {
      evaluateRun({ graph, contract, approvedRoutes: approvedFamily(graph) });
    });

    expect(elapsed).toBeLessThan(2_000);
  });

  it("handles a 10,000-deep chain without overflowing the stack", () => {
    // #given a trace that is one long chain, the shape that breaks a recursive traversal
    const graph = graphOf(deepChainRows(10_000));
    const contract = demoContract();

    const elapsed = medianMs(3, () => {
      evaluateRun({ graph, contract, approvedRoutes: approvedFamily(graph) });
    });

    expect(elapsed).toBeLessThan(5_000);
  });

  it("builds its indexes once rather than per rule", () => {
    // #given a 1,000-span trace, indexed directly and then evaluated with 500 rules
    const graph = graphOf(wideTraceRows(999));
    const indexMs = medianMs(5, () => {
      new GraphIndex(graph);
    });
    const evaluateMs = medianMs(3, () => {
      evaluateRun({ graph, contract: maximalContract(), approvedRoutes: approvedFamily(graph) });
    });

    // #then 500 rules cost far less than 500 index builds would. This is the assertion that would
    // fail if a rule ever started rebuilding the index or rescanning every span per selector.
    expect(evaluateMs).toBeLessThan(indexMs * 100);
  });

  it("re-evaluates the same graph at the same cost, so nothing accumulates between runs", () => {
    const graph = graphOf(wideTraceRows(999));
    const contract = demoContract();
    const approved = approvedFamily(graph);

    const first = medianMs(3, () => {
      evaluateRun({ graph, contract, approvedRoutes: approved });
    });
    for (let index = 0; index < 20; index += 1) {
      evaluateRun({ graph, contract, approvedRoutes: approved });
    }
    const later = medianMs(3, () => {
      evaluateRun({ graph, contract, approvedRoutes: approved });
    });

    expect(later).toBeLessThan(Math.max(first * 4, 100));
  });

  it("parses and validates every fixture contract quickly", () => {
    const sources = [DEMO_CONTRACT, path.join(FIXTURE_DIR, "selector-operators.yaml")].map((file) =>
      readFileSync(file, "utf8"),
    );

    const elapsed = medianMs(20, () => {
      for (const source of sources) parseContract(source);
    });

    expect(elapsed).toBeLessThan(100);
  });
});
