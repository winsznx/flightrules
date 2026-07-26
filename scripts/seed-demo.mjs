#!/usr/bin/env node
//
// Seeds the FlightRules application from an empty database to an active contract, entirely through
// the product's own HTTP API.
//
// PRD section 13 names `scripts/seed-demo.sh`; this is the implementation behind it. Phase 11's
// live exit gate needs a reproducible path from nothing to a gate decision, and the Phase 09 and
// Phase 10 integration suites both drop the schema, so a scripted rebuild is the only way to record
// a demo without hand-assembling state.
//
// Nothing here writes to the database, fabricates telemetry or inserts a row. Every step is a real
// API call answered by a real worker, and every wait is on a real job:
//
//   project -> agent -> baseline mining from live SigNoz traces -> route-family review ->
//   contract proposal -> validate -> approve -> activate -> SigNoz artefact sync
//
// Usage:
//   make demo-seed
//   node scripts/seed-demo.mjs [--skip-sync] [--lookback-minutes 360]

const API = (process.env.API_URL ?? "http://localhost:4000").replace(/\/+$/, "");
const PROJECT_SLUG = process.env.PROJECT ?? "demo-commerce";
const AGENT_KEY = process.env.AGENT ?? "refund-agent";
const BASELINE_RELEASE = process.env.BASELINE_RELEASE ?? "refund-agent-v1";
const ENVIRONMENT = process.env.DEPLOYMENT_ENVIRONMENT ?? "local";
const ROOT_SPAN = process.env.ROOT_SPAN ?? "refund.request";

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback;
};

const LOOKBACK_MINUTES = Number.parseInt(value("lookback-minutes", "360"), 10);
const MINIMUM_RUNS = Number.parseInt(value("minimum-runs", "20"), 10);
/** Mining attempts before giving up, and the wait between them. See the retry loop for why. */
const MINING_ATTEMPTS = Number.parseInt(value("mining-attempts", "8"), 10);
const MINING_RETRY_SECONDS = Number.parseInt(value("mining-retry-seconds", "15"), 10);
const JOB_TIMEOUT_MS = Number.parseInt(value("job-timeout-ms", "300000"), 10);

const out = (line) => process.stdout.write(`${line}\n`);
const step = (line) => process.stdout.write(`\n== ${line}\n`);

class SeedError extends Error {}

async function call(method, path, body) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      accept: "application/json",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  const contentType = response.headers.get("content-type") ?? "";
  const text = await response.text();
  // A status code is not proof of success. An unmatched path can return a front-end shell with
  // HTTP 200 (SL-012), so the body is checked before a single field is read.
  if (!contentType.includes("application/json")) {
    throw new SeedError(
      `${method} ${path} returned ${response.status} with ${contentType || "no"} content type`,
    );
  }
  const parsed = JSON.parse(text);
  if (!response.ok) {
    const code = parsed?.error?.code ?? "UNKNOWN";
    const message = parsed?.error?.message ?? text.slice(0, 200);
    throw new SeedError(`${method} ${path} failed: ${code}: ${message}`);
  }
  return parsed;
}

async function waitForJob(jobId, label) {
  const deadline = Date.now() + JOB_TIMEOUT_MS;
  let lastStage = null;
  for (;;) {
    const job = await call("GET", `/api/jobs/${jobId}`);
    if (job.progressStage && job.progressStage !== lastStage) {
      lastStage = job.progressStage;
      out(`   ${label}: ${job.progressStage}`);
    }
    if (job.status === "succeeded") return job.result ?? {};
    if (job.status === "failed" || job.status === "cancelled") {
      throw new SeedError(
        `${label} ${job.status}: ${job.error?.code ?? "UNKNOWN"}: ${job.error?.message ?? ""}`,
      );
    }
    if (Date.now() > deadline) {
      throw new SeedError(
        `${label} did not finish within ${JOB_TIMEOUT_MS} ms (status ${job.status})`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}

async function main() {
  step(`API ${API}`);
  const readiness = await call("GET", "/health/ready");
  if (readiness.status !== "ready") {
    throw new SeedError(
      `the API is not ready (database ${readiness.database}, schema compatible ${readiness.schema.compatible})`,
    );
  }
  out(`   ready, migrations ${readiness.schema.applied.join(", ")}`);

  step(`project ${PROJECT_SLUG}`);
  const projects = await call("GET", "/api/projects?limit=100");
  let project = projects.items.find((entry) => entry.slug === PROJECT_SLUG);
  if (project === undefined) {
    project = await call("POST", "/api/projects", {
      name: "Demo Commerce",
      slug: PROJECT_SLUG,
      description: "The canonical FlightRules refund-agent demo.",
      defaultEnvironment: ENVIRONMENT,
    });
    out(`   created ${project.id}`);
  } else {
    out(`   exists ${project.id}`);
  }

  step(`agent ${AGENT_KEY}`);
  const agents = await call("GET", `/api/projects/${project.id}/agents?limit=100`);
  let agent = agents.items.find((entry) => entry.agentKey === AGENT_KEY);
  if (agent === undefined) {
    agent = await call("POST", `/api/projects/${project.id}/agents`, {
      name: "Refund Agent",
      agentKey: AGENT_KEY,
      workflowNameMatcher: "refund-workflow",
      rootSpanMatcher: { name: ROOT_SPAN },
      serviceMatchers: ["flightrules-demo-agent"],
      releaseAttributeKey: "agent.release.id",
      environmentAttributeKey: "deployment.environment.name",
    });
    out(`   created ${agent.id}`);
  } else {
    out(`   exists ${agent.id}`);
  }

  const existing = await call("GET", `/api/agents/${agent.id}/contracts?limit=100`);
  const active = existing.items.find((entry) => entry.status === "active");
  if (active !== undefined) {
    out(`\n== active contract already present: ${active.id} (${active.semanticVersion})`);
    if (!flag("skip-sync")) await syncArtifacts(project.id);
    return summary(project, agent, active.id);
  }

  step(`baseline from live ${BASELINE_RELEASE} telemetry`);

  // The demo emits its telemetry seconds before this runs, and SigNoz does not make a span
  // queryable the instant it is accepted: the collector batches, and ClickHouse commits its parts
  // asynchronously. Mining once, immediately, therefore fails intermittently on a slower or busier
  // machine with "the baseline mined no route families" — a fresh-machine reproduction hit exactly
  // that. Retrying is honest here in a way it would not be inside the product: nothing is assumed
  // about the data, the same real mining job is run again, and it still has to find real runs.
  let baseline;
  let families = [];
  for (let attempt = 1; attempt <= MINING_ATTEMPTS; attempt += 1) {
    let reason = null;
    try {
      const endMs = Date.now();
      const baselineJob = await call("POST", `/api/agents/${agent.id}/baselines`, {
        releaseKey: BASELINE_RELEASE,
        environment: ENVIRONMENT,
        startMs: endMs - LOOKBACK_MINUTES * 60_000,
        endMs,
        minimumRuns: MINIMUM_RUNS,
        rootSpanName: ROOT_SPAN,
        maxTraces: 500,
      });
      const baselineResult = await waitForJob(baselineJob.jobId, "baseline");
      out(
        `   ${baselineResult.baselineIdentifier} — ${baselineResult.routeFamilies} route family(ies) from ${baselineResult.completedRuns ?? "?"} run(s)`,
      );

      baseline = await call("GET", `/api/baselines/${baselineResult.baselineId}`);
      families = [...baseline.families].sort((a, b) => b.occurrenceCount - a.occurrenceCount);
      if (families.length > 0) break;
      reason = "no route family yet";
    } catch (error) {
      // A *failed* mining job is retried on the same terms as an empty one, and for the same
      // reason. On a deployment that has just been cast, `signoz_get_field_keys` answers
      // MCP_ERROR until the field catalogue is populated from the first ingested spans, so the
      // job fails with FIELD_TYPES_UNTRUSTED rather than returning nothing — a different symptom
      // of one cause. A fresh-machine reproduction hit exactly this.
      if (!(error instanceof SeedError)) throw error;
      reason = error.message;
    }

    if (attempt === MINING_ATTEMPTS) {
      throw new SeedError(
        `the baseline produced no route family after ${MINING_ATTEMPTS} attempts. ` +
          `Last reason: ${reason}. Check that the demo topology is running and that ` +
          `${BASELINE_RELEASE} telemetry reaches SigNoz.`,
      );
    }
    out(`   ${reason}; waiting ${MINING_RETRY_SECONDS}s for SigNoz to catch up`);
    await new Promise((resolve) => setTimeout(resolve, MINING_RETRY_SECONDS * 1000));
  }

  step("route-family review");
  // The dominant family is approved; anything rarer is left pending for a human. Approving every
  // family automatically would defeat the review step the product exists to make explicit.
  const dominant = families[0];
  await call("POST", `/api/baselines/${baseline.id}/route-families/${dominant.id}/approve`, {});
  out(`   approved ${dominant.fingerprint.slice(0, 20)}… (${dominant.occurrenceCount} run(s))`);
  for (const family of families.slice(1)) {
    out(`   left pending ${family.fingerprint.slice(0, 20)}… (${family.occurrenceCount} run(s))`);
  }

  step("contract proposal");
  const proposalJob = await call("POST", `/api/baselines/${baseline.id}/propose-contract`, {
    workflowName: "refund-workflow",
    environment: ENVIRONMENT,
    contractName: "Refund Agent trajectory contract",
    semanticVersion: "1.0.0",
  });
  const proposal = await waitForJob(proposalJob.jobId, "proposal");
  const contractId = proposal.contractId;
  if (typeof contractId !== "string") {
    throw new SeedError("the proposal job returned no contract identifier");
  }
  out(`   ${contractId}`);

  step("validate, approve, activate");
  const validation = await call("POST", `/api/contracts/${contractId}/validate`, {});
  if (validation.valid !== true) {
    throw new SeedError(
      `the proposed contract does not validate: ${JSON.stringify(validation.errors).slice(0, 400)}`,
    );
  }
  out("   valid");
  await call("POST", `/api/contracts/${contractId}/approve`, {});
  out("   approved");
  await call("POST", `/api/contracts/${contractId}/activate`, {});
  out("   active");

  if (!flag("skip-sync")) await syncArtifacts(project.id);
  return summary(project, agent, contractId);
}

async function syncArtifacts(projectId) {
  step("SigNoz artefact sync");
  const response = await call("POST", "/api/setup/signoz/sync-artifacts", { projectId });
  for (const job of response.jobs) {
    const result = await waitForJob(job.jobId, `sync ${job.agentId}`);
    out(
      `   created ${result.created ?? 0}, updated ${result.updated ?? 0}, unchanged ${result.unchanged ?? 0}, conflicts ${result.conflicts ?? 0}`,
    );
  }
  for (const skipped of response.skipped ?? []) {
    out(`   skipped ${skipped.agentId}: ${skipped.reason}`);
  }
  const artifacts = await call("GET", `/api/setup/signoz/artifacts?projectId=${projectId}`);
  out(`   register: ${JSON.stringify(artifacts.summary)}`);
}

function summary(project, agent, contractId) {
  step("seeded");
  out(`   project    ${project.slug}  ${project.id}`);
  out(`   agent      ${agent.agentKey}  ${agent.id}`);
  out(`   contract   ${contractId}`);
  out("");
  out("Next:");
  out(`   FLIGHTRULES_PROJECT=${project.slug} FLIGHTRULES_AGENT=${agent.agentKey} \\`);
  out(`     FLIGHTRULES_RELEASE=${BASELINE_RELEASE} make gate`);
}

try {
  await main();
} catch (error) {
  if (error instanceof SeedError) {
    process.stderr.write(`\nseed-demo: ${error.message}\n`);
    process.exit(1);
  }
  process.stderr.write(`\nseed-demo: unexpected failure\n`);
  process.exit(1);
}
