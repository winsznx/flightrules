#!/usr/bin/env node
//
// Mines a baseline from the live known-good telemetry and writes the proposed contract.
//
// This is the Phase 08 runtime validation in one command: it retrieves fresh `refund-agent-v1` runs
// through the supported MCP Query Builder path, mines route families, approves the dominant family,
// proposes a contract, validates the emitted YAML through the Phase 07 parser, and evaluates the
// newest v1 and v2 runs against it.
//
// Nothing here is a shortcut for the product: every step calls the same exported functions the
// application will call. It exists so the evidence in docs/evidence/phase-08-result.md can be
// reproduced by a reader rather than taken on trust.
//
// Usage:
//   set -a && . ./.env && set +a
//   node scripts/mine-demo-baseline.mjs [output.yaml]

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const miner = await import(path.join(REPO_ROOT, "packages/baseline-miner/dist/index.js"));
const engine = await import(path.join(REPO_ROOT, "packages/contract-engine/dist/index.js"));
const schema = await import(path.join(REPO_ROOT, "packages/contract-schema/dist/index.js"));
const graphs = await import(path.join(REPO_ROOT, "packages/trace-graph/dist/index.js"));
const mcp = await import(path.join(REPO_ROOT, "packages/signoz-mcp/dist/index.js"));

const apiKey = process.env.SIGNOZ_API_KEY;
if (!apiKey || apiKey === "replace-me") {
  process.stderr.write("SIGNOZ_API_KEY must be set. Source .env first.\n");
  process.exit(5);
}

const OUTPUT =
  process.argv[2] ?? path.join(REPO_ROOT, "docs/evidence/phase-08/mined-contract.yaml");
const ROOT_SELECTOR = "refund.request";
const ENVIRONMENT = process.env.DEPLOYMENT_ENVIRONMENT ?? "local";
const CONTEXT = {
  searchContext: "FlightRules Phase 08 runtime validation: mine a baseline from live telemetry",
};

const caller = new mcp.StreamableToolCaller({
  url: process.env.SIGNOZ_MCP_URL ?? "http://localhost:8000/mcp",
  apiKey,
  clientName: "flightrules-mine-demo-baseline",
});
const client = new mcp.SigNozMcpClient({ caller, timeoutMs: 60_000 });
const operations = new mcp.SigNozOperations(client);
await client.discoverCapabilities();

const endMs = Date.now();
const startMs = endMs - 6 * 60 * 60 * 1000;

const out = (line) => process.stdout.write(`${line}\n`);

const selection = {
  projectKey: "demo-commerce",
  agentKey: "refund-agent",
  releaseId: "refund-agent-v1",
  environment: ENVIRONMENT,
  startMs,
  endMs,
  minimumRuns: 20,
  rootSpanName: ROOT_SELECTOR,
};

out("Field types");
const fieldTypes = await miner.verifyFieldTypes(operations, miner.MINING_SELECT_FIELDS, CONTEXT);
if (!fieldTypes.ok) {
  out(`  FAILED ${fieldTypes.error.code}: ${fieldTypes.error.message}`);
  await client.close();
  process.exit(4);
}
out(`  verified   ${fieldTypes.report.verified.length}: ${fieldTypes.report.verified.join(", ")}`);
out(
  `  unverified ${fieldTypes.report.unverified.length}: ${fieldTypes.report.unverified.join(", ")}`,
);

const mined = await miner.mineBaseline({
  selection,
  source: miner.signozTraceSource(operations, CONTEXT),
  onProgress: (progress) => out(`  [${progress.stage}] ${progress.detail}`),
});
if (!mined.ok) {
  out(`\nMINING FAILED\n${JSON.stringify(mined.errors, null, 2)}`);
  await client.close();
  process.exit(4);
}

const { baseline, runsByFingerprint } = mined.value;
out("\nBaseline");
out(`  id              ${baseline.id}`);
out(`  status          ${baseline.status}`);
out(`  selection hash  ${baseline.selectionHash}`);
out(`  normaliser      ${baseline.normaliserVersion} (${baseline.normaliserConfigHash})`);
out(
  `  window          ${new Date(baseline.sourceTimeStartMs).toISOString()} .. ${new Date(baseline.sourceTimeEndMs).toISOString()}`,
);
out(`  counts          ${JSON.stringify(baseline.counts)}`);
out(`  retrieval       ${JSON.stringify(baseline.retrieval)}`);

out("\nRoute families");
for (const family of baseline.families) {
  out(`  ${family.fingerprint}`);
  out(`    id            ${family.id}`);
  out(
    `    occurrences   ${family.occurrenceCount} (${family.occurrencePercent.decimal})  rare=${family.rare}`,
  );
  out(`    nodes/edges   ${family.statistics.nodes.length}/${family.statistics.edges.length}`);
  out(`    duration ms   ${JSON.stringify(family.statistics.duration)}`);
  out(
    `    tokens        input=${JSON.stringify(family.statistics.inputTokens)} output=${JSON.stringify(family.statistics.outputTokens)}`,
  );
  out(`    tools         ${family.statistics.tools.join(", ")}`);
  out(`    services      ${family.statistics.services.join(", ")}`);
  out(`    side effects  ${family.statistics.sideEffects.join(", ")}`);
  out(`    warnings      ${JSON.stringify(family.statistics.qualityWarnings)}`);
  out(`    representative ${family.representativeTraceIds.join(", ")}`);
}

out("\nExcluded traces");
if (baseline.excluded.length === 0) out("  none");
for (const excluded of baseline.excluded) {
  out(`  ${excluded.traceId}  ${excluded.reason}  ${excluded.detail}`);
}

out("\nBaseline disclosures");
for (const disclosure of baseline.disclosures) {
  out(`  ${disclosure.code} [${disclosure.subject}] x${disclosure.count}: ${disclosure.detail}`);
}

const decided = miner.applyRouteDecisions(
  baseline,
  baseline.families.map((family) => ({ fingerprint: family.fingerprint, decision: "approve" })),
);
if (!decided.ok) {
  out(`\nAPPROVAL REFUSED\n${JSON.stringify(decided.errors, null, 2)}`);
  await client.close();
  process.exit(4);
}
out(
  `\nAfter human approval: status ${decided.baseline.status}, ${miner.approvedFingerprints(decided.baseline).length} approved family/families`,
);

const proposed = miner.proposeContract({
  baseline: decided.baseline,
  runsByFingerprint,
  options: {
    createdAt: "2026-07-25T00:00:00Z",
    environment: "production",
    workflowName: "refund-workflow",
  },
});
if (!proposed.ok) {
  out(`\nPROPOSAL FAILED\n${JSON.stringify(proposed.errors, null, 2)}`);
  await client.close();
  process.exit(4);
}

const proposal = proposed.proposal;
out("\nProposal");
out(`  status        ${proposal.status}`);
out(`  content hash  ${proposal.contentHash}`);
out(`  sample size   ${proposal.sampleSize}`);
out(`  rules         ${proposal.rules.length}`);
for (const entry of proposal.rules) {
  out(`    ${entry.rule.severity.padEnd(8)} ${entry.rule.type.padEnd(20)} ${entry.rule.id}`);
}
out(
  `  zero tolerance ${proposal.contract.spec.gate.zeroToleranceRuleIds.length}: ${proposal.contract.spec.gate.zeroToleranceRuleIds.join(", ")}`,
);
out("  disclosures");
for (const disclosure of proposal.disclosures) {
  out(`    ${disclosure.code} [${disclosure.subject}] x${disclosure.count}`);
}

const emitted = miner.emitContractYaml(proposal);
if (!emitted.ok) {
  out(`\nEMIT FAILED ${emitted.error.code}: ${emitted.error.message}`);
  await client.close();
  process.exit(4);
}
writeFileSync(OUTPUT, emitted.yaml, { mode: 0o644 });
out(
  `\nWrote ${OUTPUT} (${Buffer.byteLength(emitted.yaml, "utf8")} bytes, hash ${emitted.contentHash})`,
);

const reparsed = schema.parseContract(readFileSync(OUTPUT, "utf8"));
if (!reparsed.ok) {
  out(`\nVALIDATION FAILED\n${schema.formatValidationErrors(reparsed.errors)}`);
  await client.close();
  process.exit(4);
}
out(
  `Phase 07 validator: valid, ${reparsed.value.contract.spec.rules.length} rules, hash ${reparsed.value.contentHash}`,
);
out(`Round trip: ${reparsed.value.contentHash === proposal.contentHash ? "identical" : "DRIFTED"}`);

async function newestRunRows(releaseId) {
  const found = await operations.executeBuilderQuery(
    mcp.buildTraceQuery({
      filter: `agent.release.id = '${releaseId}' AND name = '${ROOT_SELECTOR}'`,
      selectFields: [{ name: "trace_id", context: "span", dataType: "string" }],
      startMs,
      endMs,
      limit: 1,
      orderDirection: "desc",
    }),
    CONTEXT,
  );
  if (found.outcome !== "SUCCESS_WITH_ROWS")
    throw new Error(`no ${releaseId} run: ${found.outcome}`);
  const traceId = mcp.rowsOf(found.value)[0].data.trace_id;
  const spans = await operations.getTraceSpans(
    traceId,
    {
      selectFields: miner.MINING_SELECT_FIELDS.map((field) => ({
        name: field.name,
        context: field.context,
        dataType: field.dataType,
      })),
      startMs,
      endMs,
      limit: 500,
    },
    CONTEXT,
  );
  if (spans.outcome !== "SUCCESS_WITH_ROWS") throw new Error(`fetch failed: ${spans.outcome}`);
  return { traceId, rows: mcp.rowsOf(spans.value).map((row) => row.data) };
}

const approvedRoutes = miner.approvedRouteInputs(decided.baseline);

for (const releaseId of ["refund-agent-v1", "refund-agent-v2"]) {
  const { traceId, rows } = await newestRunRows(releaseId);
  const graph = graphs.buildTraceGraph(rows, { rootSelector: ROOT_SELECTOR });
  const { evaluation } = engine.evaluateRun({ graph, contract: proposal.contract, approvedRoutes });

  out(`\n${releaseId} (trace ${traceId}) against the generated proposal`);
  out(`  fingerprint ${evaluation.routeFingerprint}`);
  out(
    `  status ${evaluation.status}  quality ${evaluation.traceQuality}  similarity ${evaluation.similarity.decimal}`,
  );
  out(`  counts ${JSON.stringify(evaluation.counts)}`);
  for (const violation of evaluation.violations) {
    out(
      `    [${violation.severity}${violation.zeroTolerance ? "/zt" : ""}] ${violation.code} ${violation.ruleId} :: ${violation.summary}`,
    );
  }
  for (const result of evaluation.ruleResults) {
    if (result.outcome === "insufficient_evidence") {
      out(`    (insufficient/${result.insufficientReason}) ${result.ruleId}`);
    }
    if (result.outcome === "deferred") out(`    (deferred) ${result.ruleId}`);
  }
}

out("\nRepeated mining over the same window");
const second = await miner.mineBaseline({
  selection,
  source: miner.signozTraceSource(operations, CONTEXT),
});
if (!second.ok) {
  out(`  FAILED ${JSON.stringify(second.errors)}`);
  await client.close();
  process.exit(4);
}
const secondDecided = miner.applyRouteDecisions(
  second.value.baseline,
  second.value.baseline.families.map((family) => ({
    fingerprint: family.fingerprint,
    decision: "approve",
  })),
);
const secondProposal = miner.proposeContract({
  baseline: secondDecided.baseline,
  runsByFingerprint: second.value.runsByFingerprint,
  options: {
    createdAt: "2026-07-25T00:00:00Z",
    environment: "production",
    workflowName: "refund-workflow",
  },
});
const secondEmitted = miner.emitContractYaml(secondProposal.proposal);
out(`  baseline id identical:  ${second.value.baseline.id === baseline.id}`);
out(`  content hash identical: ${secondProposal.proposal.contentHash === proposal.contentHash}`);
out(`  emitted YAML identical: ${secondEmitted.yaml === emitted.yaml}`);

await client.close();
