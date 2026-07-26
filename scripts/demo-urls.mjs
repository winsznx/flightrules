#!/usr/bin/env node
//
// Prints every URL the demo video needs, and writes them to a stable state file.
//
// The identifiers in this product are UUIDv7: they change on every reset, so a demo script that
// hard-coded one would be wrong the first time anybody followed it. This resolves them from the
// running API and writes `.demo-state.json`, which the script and the presenter both read.
//
// Read-only. It creates nothing, changes nothing, and fails loudly if the demo is not seeded.
//
//   make demo-urls

import { writeFile } from "node:fs/promises";

const API = (process.env.API_URL ?? "http://localhost:4000").replace(/\/+$/, "");
const WEB = (process.env.WEB_URL ?? "http://localhost:3100").replace(/\/+$/, "");
const SIGNOZ = (process.env.SIGNOZ_URL ?? "http://localhost:8080").replace(/\/+$/, "");
const PROJECT_SLUG = process.env.PROJECT ?? "demo-commerce";

async function json(path) {
  const response = await fetch(`${API}${path}`, { headers: { accept: "application/json" } });
  const contentType = response.headers.get("content-type") ?? "";
  // A status code is not proof of success (SL-012).
  if (!contentType.includes("application/json")) {
    throw new Error(`${path} returned ${response.status} with ${contentType || "no"} content type`);
  }
  const body = await response.json();
  if (!response.ok) throw new Error(`${path}: ${body?.error?.code ?? response.status}`);
  return body;
}

function required(value, what) {
  if (value === undefined || value === null) {
    throw new Error(`${what} is not present. Run \`make demo-full\` first.`);
  }
  return value;
}

const projects = await json("/api/projects?limit=100");
const project = required(
  projects.items.find((entry) => entry.slug === PROJECT_SLUG),
  `project ${PROJECT_SLUG}`,
);

const agents = await json(`/api/projects/${project.id}/agents?limit=100`);
const agent = required(agents.items[0], "an agent in the demo project");

const contracts = await json(`/api/agents/${agent.id}/contracts?limit=100`);
const contract = required(
  contracts.items.find((entry) => entry.status === "active") ?? contracts.items[0],
  "a contract",
);

const releases = await json(`/api/agents/${agent.id}/releases?limit=100`);
const v1 = releases.items.find((entry) => entry.releaseKey === "refund-agent-v1") ?? null;
const v2 = releases.items.find((entry) => entry.releaseKey === "refund-agent-v2") ?? null;

const baselines = await json(`/api/agents/${agent.id}/baselines?limit=100`);
const baseline = baselines.items[0] ?? null;
const family =
  baseline === null ? null : ((await json(`/api/baselines/${baseline.id}`)).families[0] ?? null);

// The three violations the demo exists to reveal, found by rule prefix rather than by identifier.
const violations = await json(`/api/projects/${project.id}/violations?limit=100`);
const critical = {};
for (const prefix of [
  "require-policy-retrieve",
  "require-fraud-check",
  "single-payment-refund-write",
]) {
  const found = violations.items.find((entry) => entry.ruleKey.startsWith(prefix));
  critical[prefix] = found?.id ?? null;
}

const agentBase = `${WEB}/projects/${project.id}/agents/${agent.id}`;
const state = {
  capturedAt: new Date().toISOString(),
  web: WEB,
  api: API,
  signoz: SIGNOZ,
  projectId: project.id,
  agentId: agent.id,
  contractId: contract.id,
  baselineId: baseline?.id ?? null,
  routeFamilyId: family?.id ?? null,
  releaseV1Id: v1?.id ?? null,
  releaseV2Id: v2?.id ?? null,
  violations: critical,
  urls: {
    demo: `${WEB}/demo`,
    projects: `${WEB}/projects`,
    overview: `${WEB}/projects/${project.id}/overview`,
    agent: agentBase,
    baselineCapture: `${agentBase}/baselines/new`,
    baselineResult: baseline === null ? null : `${agentBase}/baselines/new?baseline=${baseline.id}`,
    routeFamily: family === null ? null : `${agentBase}/routes/${family.id}`,
    contractStudio: `${agentBase}/contracts/${contract.id}`,
    releases: `${agentBase}/releases`,
    releasesFailing: `${agentBase}/releases?decision=fail`,
    releaseV1: v1 === null ? null : `${agentBase}/releases/${v1.id}`,
    releaseV2: v2 === null ? null : `${agentBase}/releases/${v2.id}`,
    signozIntegration: `${WEB}/projects/${project.id}/integrations/signoz`,
    violationMissingPolicy:
      critical["require-policy-retrieve"] === null
        ? null
        : `${WEB}/projects/${project.id}/violations/${critical["require-policy-retrieve"]}`,
    violationMissingFraud:
      critical["require-fraud-check"] === null
        ? null
        : `${WEB}/projects/${project.id}/violations/${critical["require-fraud-check"]}`,
    violationDuplicateRefund:
      critical["single-payment-refund-write"] === null
        ? null
        : `${WEB}/projects/${project.id}/violations/${critical["single-payment-refund-write"]}`,
  },
};

await writeFile(".demo-state.json", `${JSON.stringify(state, null, 2)}\n`, "utf8");

const out = (line) => process.stdout.write(`${line}\n`);
out("");
out(`FlightRules demo URLs — written to .demo-state.json at ${state.capturedAt}`);
out("");
out(`  project   ${PROJECT_SLUG}  ${project.id}`);
out(`  agent     ${agent.agentKey}  ${agent.id}`);
out(`  contract  ${contract.contractKey} ${contract.semanticVersion} (${contract.status})`);
out("");
for (const [name, url] of Object.entries(state.urls)) {
  out(`  ${name.padEnd(26)} ${url ?? "— not seeded —"}`);
}
out("");

const missing = Object.entries(state.urls).filter(([, url]) => url === null);
if (missing.length > 0) {
  process.stderr.write(
    `\n${missing.length} URL(s) are not available. Run \`make demo-full\` and try again.\n`,
  );
  process.exit(1);
}
