#!/usr/bin/env node
/**
 * Measures every PRD section 20.2 performance target (PRD Phase 16 tasks 5 and 14).
 *
 * `packages/contract-engine/src/performance.test.ts` already *guards* these with budgets, which is
 * what stops a regression. This is the other half: the budgets are deliberately generous so they
 * survive a slower machine, so passing them says "not catastrophically slow", not "meets the
 * target". A target is only met once it has been measured.
 *
 * Repetitions, median, p95, maximum and peak heap, on recorded hardware, warm and cold. One
 * favourable run is not evidence.
 *
 *   node scripts/measure-performance.mjs [--repetitions 30] [--json]
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const { parseContract, formatValidationErrors } = await import(
  path.join(REPO_ROOT, "packages/contract-schema/dist/index.js")
);
const { buildTraceGraph, canonicaliseGraph, fingerprintGraph, serialiseCanonicalGraph } =
  await import(path.join(REPO_ROOT, "packages/trace-graph/dist/index.js"));
const { evaluateRun } = await import(path.join(REPO_ROOT, "packages/contract-engine/dist/index.js"));

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const repetitions = Number(args[args.indexOf("--repetitions") + 1]) || 30;
const apiUrl = process.env["API_URL"] ?? `http://localhost:${process.env["API_PORT"] ?? "4000"}`;

const ROOT_SELECTOR = "refund.request";

function contract() {
  const source = readFileSync(
    path.join(REPO_ROOT, "contracts/demo-commerce/refund-agent/production/contract.yaml"),
    "utf8",
  );
  const result = parseContract(source);
  if (!result.ok) throw new Error(formatValidationErrors(result.errors));
  return result.value.contract;
}

function spanId(index) {
  return index.toString(16).padStart(16, "0");
}

/** A synthetic trace of `count` spans, shaped like the demo's: a root with a wide, named fan-out. */
function rows(count) {
  const names = [
    "policy.retrieve",
    "order.lookup",
    "fraud.check",
    "refund.calculate",
    "payment.refund",
    "customer.notify",
  ];
  const built = [
    {
      trace_id: "0123456789abcdef0123456789abcdef",
      span_id: spanId(1),
      parent_span_id: null,
      name: ROOT_SELECTOR,
      "service.name": "flightrules-demo-agent",
      timestamp: "2026-07-25T00:00:00.000Z",
      duration_nano: 50_000_000,
      "agent.release.id": "refund-agent-v1",
    },
  ];
  for (let index = 2; index <= count; index += 1) {
    built.push({
      trace_id: "0123456789abcdef0123456789abcdef",
      span_id: spanId(index),
      parent_span_id: spanId(1),
      name: names[index % names.length],
      "service.name": `flightrules-service-${String(index % 6)}`,
      timestamp: "2026-07-25T00:00:00.001Z",
      duration_nano: 1_000_000,
      "agent.side_effect": index % 5 === 0 ? "write" : "read",
    });
  }
  return built;
}

function stats(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (fraction) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
  return {
    runs: sorted.length,
    medianMs: Number(at(0.5).toFixed(2)),
    p95Ms: Number(at(0.95).toFixed(2)),
    maxMs: Number(sorted[sorted.length - 1].toFixed(2)),
    minMs: Number(sorted[0].toFixed(2)),
  };
}

/** One cold sample (first call, nothing warmed) then `repetitions` warm ones. */
function measure(name, target, budgetMs, work) {
  const heapBefore = process.memoryUsage().heapUsed;

  const coldStart = performance.now();
  work();
  const coldMs = performance.now() - coldStart;

  const samples = [];
  for (let index = 0; index < repetitions; index += 1) {
    const start = performance.now();
    work();
    samples.push(performance.now() - start);
  }

  const peakHeapMb = Number(
    ((process.memoryUsage().heapUsed - heapBefore) / 1024 / 1024).toFixed(1),
  );
  const summary = stats(samples);
  const met = summary.p95Ms < budgetMs;
  return {
    name,
    target,
    budgetMs,
    coldMs: Number(coldMs.toFixed(2)),
    ...summary,
    peakHeapDeltaMb: peakHeapMb,
    met,
  };
}

const results = [];
const active = contract();

// PRD 20.2: evaluate a 100-span trace in less than 250 ms p95, excluding network fetch.
{
  const graph = buildTraceGraph(rows(100), { rootSelector: ROOT_SELECTOR });
  results.push(
    measure(
      "evaluate a 100-span trace",
      "< 250 ms p95",
      250,
      () => void evaluateRun({ graph, contract: active, approvedRoutes: [] }),
    ),
  );
}

// PRD 20.2: canonicalise a 1,000-span trace in less than 1 second p95.
{
  const built = rows(1_000);
  results.push(
    measure("canonicalise a 1,000-span trace", "< 1,000 ms p95", 1_000, () => {
      const graph = buildTraceGraph(built, { rootSelector: ROOT_SELECTOR });
      serialiseCanonicalGraph(canonicaliseGraph(graph));
      fingerprintGraph(graph);
    }),
  );
}

// PRD Phase 16 task 5 names a 10,000-span canonicalisation explicitly.
{
  const built = rows(10_000);
  results.push(
    measure("canonicalise a 10,000-span trace", "no superlinear blow-up", 10_000, () => {
      const graph = buildTraceGraph(built, { rootSelector: ROOT_SELECTOR, maxSpans: 10_001 });
      serialiseCanonicalGraph(canonicaliseGraph(graph));
    }),
  );
}

// PRD 20.2: evaluate 100 fetched traces in less than 30 seconds after data is available.
{
  const graphs = Array.from({ length: 100 }, () =>
    buildTraceGraph(rows(100), { rootSelector: ROOT_SELECTOR }),
  );
  results.push(
    measure("evaluate 100 fetched 100-span traces", "< 30,000 ms p95", 30_000, () => {
      for (const graph of graphs) evaluateRun({ graph, contract: active, approvedRoutes: [] });
    }),
  );
}

// PRD 20.2: API p95 under 500 ms for non-job endpoints on local deployment.
let apiResult = null;
try {
  const samples = [];
  const url = `${apiUrl}/health/ready`;
  await fetch(url);
  for (let index = 0; index < repetitions; index += 1) {
    const start = performance.now();
    const response = await fetch(url);
    await response.text();
    samples.push(performance.now() - start);
  }
  const summary = stats(samples);
  apiResult = {
    name: "API non-job endpoint (GET /health/ready)",
    target: "< 500 ms p95",
    budgetMs: 500,
    coldMs: null,
    ...summary,
    peakHeapDeltaMb: null,
    met: summary.p95Ms < 500,
  };
  results.push(apiResult);
} catch {
  results.push({
    name: "API non-job endpoint (GET /health/ready)",
    target: "< 500 ms p95",
    budgetMs: 500,
    coldMs: null,
    runs: 0,
    medianMs: null,
    p95Ms: null,
    maxMs: null,
    minMs: null,
    peakHeapDeltaMb: null,
    met: null,
    note: `the API was not reachable at ${apiUrl}; start it and re-run`,
  });
}

const environment = {
  platform: `${os.type()} ${os.release()} ${os.arch()}`,
  cpu: os.cpus()[0]?.model ?? "unknown",
  cores: os.cpus().length,
  totalMemoryGb: Number((os.totalmem() / 1024 ** 3).toFixed(1)),
  node: process.version,
  repetitions,
  commit: (() => {
    try {
      return execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
    } catch {
      return "unknown";
    }
  })(),
};

if (asJson) {
  process.stdout.write(`${JSON.stringify({ environment, results }, null, 2)}\n`);
} else {
  process.stdout.write("\nEnvironment\n");
  for (const [key, value] of Object.entries(environment)) {
    process.stdout.write(`  ${key.padEnd(14)} ${String(value)}\n`);
  }
  process.stdout.write("\nPRD section 20.2 targets\n");
  process.stdout.write(
    `  ${"measurement".padEnd(42)}${"target".padEnd(24)}${"cold".padEnd(10)}${"median".padEnd(10)}${"p95".padEnd(10)}${"max".padEnd(10)}heapΔ\n`,
  );
  for (const result of results) {
    const marker = result.met === null ? "  ??  " : result.met ? "  ok  " : " FAIL ";
    process.stdout.write(
      `${marker}${result.name.padEnd(42)}${result.target.padEnd(24)}` +
        `${String(result.coldMs ?? "-").padEnd(10)}${String(result.medianMs ?? "-").padEnd(10)}` +
        `${String(result.p95Ms ?? "-").padEnd(10)}${String(result.maxMs ?? "-").padEnd(10)}` +
        `${result.peakHeapDeltaMb === null ? "-" : `${String(result.peakHeapDeltaMb)} MB`}\n`,
    );
    if (result.note) process.stdout.write(`        note: ${result.note}\n`);
  }
  process.stdout.write("\n");
}

const failed = results.filter((result) => result.met === false);
if (failed.length > 0) {
  process.stderr.write(
    `${String(failed.length)} PRD section 20.2 target(s) not met: ${failed.map((r) => r.name).join(", ")}\n`,
  );
  process.exit(1);
}
