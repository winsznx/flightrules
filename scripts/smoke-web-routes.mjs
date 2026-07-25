// Phase 12 route smoke: every PRD section 8 route, against the running web application and the
// running API, with the seeded demo data. Records the status and the route's own test marker.
import { writeFile } from "node:fs/promises";

const API = "http://localhost:4000";
const WEB = "http://localhost:3100";

const json = async (path) => (await fetch(`${API}${path}`)).json();

const projects = await json("/api/projects?limit=100");
const project = projects.items.find((entry) => entry.slug === "demo-commerce");
if (!project) throw new Error("demo-commerce is not seeded");

const agents = await json(`/api/projects/${project.id}/agents?limit=100`);
const agent = agents.items[0];
const contracts = await json(`/api/agents/${agent.id}/contracts?limit=100`);
const contract = contracts.items.find((entry) => entry.status === "active") ?? contracts.items[0];
const releases = await json(`/api/agents/${agent.id}/releases?limit=100`);
const release = releases.items.find((entry) => entry.releaseKey === "refund-agent-v2");
const baselineRelease = releases.items.find((entry) => entry.releaseKey === "refund-agent-v1");
const violations = await json(`/api/projects/${project.id}/violations?limit=1`);
const violation = violations.items[0];
const baselines = await json(`/api/agents/${agent.id}/baselines?limit=1`);
const baseline = await json(`/api/baselines/${baselines.items[0].id}`);
const family = baseline.families[0];

const substitutions = [
  [project.id, ":project"],
  [agent.id, ":agent"],
  [contract.id, ":contract"],
  [release?.id ?? "-", ":release"],
  [violation?.id ?? "-", ":violation"],
  [family.id, ":family"],
];

const routes = [
  "/",
  "/setup",
  "/projects",
  "/demo",
  `/projects/${project.id}/overview`,
  `/projects/${project.id}/agents`,
  `/projects/${project.id}/agents/${agent.id}`,
  `/projects/${project.id}/agents/${agent.id}?tab=routes`,
  `/projects/${project.id}/agents/${agent.id}?tab=contracts`,
  `/projects/${project.id}/agents/${agent.id}?tab=releases`,
  `/projects/${project.id}/agents/${agent.id}?tab=violations`,
  `/projects/${project.id}/agents/${agent.id}?tab=telemetry`,
  `/projects/${project.id}/agents/${agent.id}/baselines/new`,
  `/projects/${project.id}/agents/${agent.id}/routes/${family.id}`,
  `/projects/${project.id}/agents/${agent.id}/contracts/${contract.id}`,
  `/projects/${project.id}/agents/${agent.id}/releases`,
  `/projects/${project.id}/agents/${agent.id}/releases/${release.id}`,
  `/projects/${project.id}/agents/${agent.id}/releases/${baselineRelease.id}`,
  `/projects/${project.id}/violations/${violation.id}`,
  `/projects/${project.id}/integrations/signoz`,
];

const lines = [
  `# Phase 12 route smoke — captured ${new Date().toISOString()}`,
  "",
  `project    demo-commerce  ${project.id}`,
  `agent      ${agent.agentKey}  ${agent.id}`,
  `contract   ${contract.contractKey} ${contract.semanticVersion} (${contract.status})  ${contract.id}`,
  "",
  "HTTP  MARKER            EVIDENCE                       ROUTE",
];

let failures = 0;
for (const route of routes) {
  const response = await fetch(`${WEB}${route}`);
  const body = await response.text();
  const marker = /data-testid="route-([a-z-]+)"/.exec(body)?.[1] ?? "—";

  // Something real on the page, so a 200 with an empty shell cannot pass as a rendered route.
  const evidence = [];
  if (body.includes("fr-page-title") || body.includes("fr-landing-hero__title"))
    evidence.push("title");
  if (/fr-table|fr-dl|fr-stat|fr-steps|fr-state/.test(body)) evidence.push("content");
  if (body.includes("Skip to content")) evidence.push("skip");
  // No credential, no database column and no raw payload may reach the browser.
  const leaks = [];
  if (/SIGNOZ-API-KEY/i.test(body)) leaks.push("api-key");
  if (/postgres:\/\//.test(body)) leaks.push("dsn");
  if (/result_json|canonical_graph_json|summary_json/.test(body)) leaks.push("column");
  if (body.includes("Ignore and pass release")) leaks.push("forbidden-action");

  const short = substitutions.reduce((value, [from, to]) => value.split(from).join(to), route);
  const ok =
    response.status === 200 && marker !== "—" && evidence.length >= 2 && leaks.length === 0;
  if (!ok) failures += 1;
  lines.push(
    `${String(response.status).padEnd(5)} ${marker.padEnd(17)} ${(leaks.length > 0 ? `LEAK:${leaks.join(",")}` : evidence.join("+")).padEnd(30)} ${short}`,
  );
}

lines.push("");
lines.push(
  failures === 0
    ? `All ${routes.length} route responses rendered real content and leaked nothing.`
    : `${failures} route(s) failed.`,
);

const report = `${lines.join("\n")}\n`;
process.stdout.write(report);
await writeFile("docs/evidence/phase-12/route-smoke.txt", report, "utf8");
process.exit(failures === 0 ? 0 : 1);
