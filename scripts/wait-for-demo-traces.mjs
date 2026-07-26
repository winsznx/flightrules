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
    console.error(
      `${releaseId} never became queryable after ${ATTEMPTS} attempts. ` +
        "The telemetry was not emitted, or ingestion is broken.",
    );
    failed = true;
  }
}

await client.close().catch(() => {});
process.exit(failed ? 1 : 0);
