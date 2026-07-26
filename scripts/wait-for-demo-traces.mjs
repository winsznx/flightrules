#!/usr/bin/env node
/**
 * Waits until the demo releases named on the command line are queryable in SigNoz.
 *
 * SigNoz does not make a span queryable the instant it accepts it: the collector batches and
 * ClickHouse commits its parts asynchronously. On a freshly cast deployment the gap is seconds to a
 * minute. A suite that queries inside that gap reports "no run in the last 6 hours" — which is
 * indistinguishable from telemetry that was never emitted, and is exactly how the SigNoz job's
 * integration suite failed the first time it ran on GitHub with a demo batch in front of it.
 *
 * This polls the same supported retrieval path the product uses, through the pinned MCP server, and
 * exits non-zero when a release never appears. It is a readiness probe, never a retry that turns a
 * real absence into a pass: the query it runs is the query the suite runs.
 *
 *   node scripts/wait-for-demo-traces.mjs refund-agent-v1 refund-agent-v2
 */
import {
  buildTraceQuery,
  rowsOf,
  SigNozMcpClient,
  SigNozOperations,
  StreamableToolCaller,
} from "@flightrules/signoz-mcp";

const releases = process.argv.slice(2);
if (releases.length === 0) {
  console.error("usage: wait-for-demo-traces.mjs <release-id> [release-id ...]");
  process.exit(5);
}

const mcpUrl = process.env["SIGNOZ_MCP_URL"] ?? "http://localhost:8000/mcp";
const apiKey = process.env["SIGNOZ_API_KEY"];
if (!apiKey || apiKey === "replace-me") {
  console.error("SIGNOZ_API_KEY must be set. Run scripts/bootstrap-signoz.sh and source .env.");
  process.exit(5);
}

const ATTEMPTS = Number.parseInt(process.env["TRACE_WAIT_ATTEMPTS"] ?? "20", 10);
const INTERVAL_MS = Number.parseInt(process.env["TRACE_WAIT_INTERVAL_MS"] ?? "15000", 10);
const CONTEXT = "FlightRules CI readiness probe: are the demo runs queryable yet";
const ROOT_SELECTOR = "refund.request";

const caller = new StreamableToolCaller({
  url: mcpUrl,
  apiKey,
  clientName: "flightrules-trace-readiness",
});
const client = new SigNozMcpClient({ caller, timeoutMs: 60_000 });
const operations = new SigNozOperations(client);
await client.discoverCapabilities();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function isQueryable(releaseId) {
  const endMs = Date.now();
  const found = await operations.executeBuilderQuery(
    buildTraceQuery({
      filter: `agent.release.id = '${releaseId}' AND name = '${ROOT_SELECTOR}'`,
      selectFields: [{ name: "trace_id", context: "span" }],
      startMs: endMs - 6 * 60 * 60 * 1000,
      endMs,
      limit: 1,
      orderDirection: "desc",
    }),
    { searchContext: CONTEXT },
  );
  return found.outcome === "SUCCESS_WITH_ROWS";
}

/**
 * What SigNoz holds for the window, with no filter at all.
 *
 * "The release never became queryable" has two very different causes, and the retry loop alone
 * cannot tell them apart: nothing was ingested, or something was ingested that the filter does not
 * match. This answers that question in the same run rather than in the next one.
 */
async function describeWindow() {
  const endMs = Date.now();
  const found = await operations.executeBuilderQuery(
    buildTraceQuery({
      filter: "",
      selectFields: [
        { name: "service.name", context: "resource" },
        { name: "name", context: "span" },
        { name: "agent.release.id", context: "tag" },
      ],
      startMs: endMs - 6 * 60 * 60 * 1000,
      endMs,
      limit: 200,
      orderDirection: "desc",
    }),
    { searchContext: CONTEXT },
  );
  if (found.outcome !== "SUCCESS_WITH_ROWS")
    return `no spans at all in the window (${found.outcome})`;
  const rows = rowsOf(found.value);
  const services = new Set();
  const spanNames = new Set();
  const releaseIds = new Set();
  for (const row of rows) {
    services.add(String(row.data["service.name"] ?? "?"));
    spanNames.add(String(row.data["name"] ?? "?"));
    releaseIds.add(String(row.data["agent.release.id"] ?? "(unset)"));
  }
  return [
    `${rows.length} span(s) in the window`,
    `  services:     ${[...services].sort().join(", ")}`,
    `  span names:   ${[...spanNames].sort().slice(0, 12).join(", ")}`,
    `  release ids:  ${[...releaseIds].sort().join(", ")}`,
  ].join("\n");
}

/**
 * Whether SigNoz's service catalogue lists the agent yet.
 *
 * `signoz_list_services` is not the raw span table: it lags it on a freshly cast deployment, so a
 * trace can be queryable minutes before the service that produced it appears in the catalogue. The
 * integration suite asserts both, and on the first runner that reached it the catalogue was still
 * empty while every trace query already returned rows.
 */
async function agentIsCatalogued() {
  const listed = await operations.listServices({ timeRange: "6h" }, { searchContext: CONTEXT });
  return (
    listed.outcome === "SUCCESS_WITH_ROWS" &&
    JSON.stringify(listed.value).includes("flightrules-demo-agent")
  );
}

let failed = false;
for (const releaseId of releases) {
  let queryable = false;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    queryable = await isQueryable(releaseId);
    if (queryable) {
      process.stdout.write(`${releaseId} is queryable (attempt ${attempt})\n`);
      break;
    }
    if (attempt < ATTEMPTS) {
      process.stdout.write(`${releaseId} not queryable yet; waiting ${INTERVAL_MS} ms\n`);
      await sleep(INTERVAL_MS);
    }
  }
  if (!queryable) {
    console.error(`${releaseId} never became queryable after ${ATTEMPTS} attempts.`);
    console.error(
      await describeWindow().catch((error) => `the window query also failed: ${error}`),
    );
    failed = true;
  }
}

if (!failed) {
  let catalogued = false;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    catalogued = await agentIsCatalogued();
    if (catalogued) {
      process.stdout.write(`the service catalogue lists the agent (attempt ${attempt})\n`);
      break;
    }
    if (attempt < ATTEMPTS) {
      process.stdout.write(`the service catalogue is still empty; waiting ${INTERVAL_MS} ms\n`);
      await sleep(INTERVAL_MS);
    }
  }
  if (!catalogued) {
    console.error(
      `SigNoz never listed flightrules-demo-agent after ${ATTEMPTS} attempts, ` +
        "although its traces are queryable.",
    );
    failed = true;
  }
}

await client.close().catch(() => {});
process.exit(failed ? 1 : 0);
