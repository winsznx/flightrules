#!/usr/bin/env node
/**
 * Deletes every managed SigNoz artefact belonging to a project.
 *
 * Needed when the FlightRules database is rebuilt while SigNoz keeps its resources: the artefact
 * register is then empty while the managed names still exist remotely, and the next sync correctly
 * reports every one of them as a conflict because nothing recorded creating them. This is the
 * deliberate operator action that resolves that, and it is deliberately not something a sync does
 * on its own — deleting a resource somebody may rely on is not a side effect.
 *
 * It also clears the project's register rows and the completed `signoz_sync` jobs, because the sync
 * job is idempotent on the contract's content: without that, a sync requested after a purge returns
 * the *previous* job's cached conflict result and nothing is ever recreated. Deleting the remote
 * resources alone therefore leaves the deployment permanently unsyncable, which is what this second
 * half exists to prevent. Both are operator recovery actions on state the operator just destroyed —
 * nothing here is evidence of anything, and the product never does it on its own.
 *
 * Usage:
 *   node scripts/purge-managed-artifacts.mjs <project-slug>
 */
import process from "node:process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const projectSlug = process.argv[2];
const apiKey = process.env["SIGNOZ_API_KEY"];
const url = process.env["SIGNOZ_MCP_URL"] ?? "http://localhost:8000/mcp";

if (!projectSlug) {
  process.stderr.write("usage: node scripts/purge-managed-artifacts.mjs <project-slug>\n");
  process.exit(2);
}
if (!apiKey || apiKey === "replace-me") {
  process.stderr.write("SIGNOZ_API_KEY is not set. Source .env first.\n");
  process.exit(5);
}

const prefix = `FlightRules / ${projectSlug} / `;
const searchContext = `FlightRules maintenance: delete the managed SigNoz artefacts of project ${projectSlug}`;

const transport = new StreamableHTTPClientTransport(new URL(url), {
  requestInit: { headers: { "SIGNOZ-API-KEY": apiKey } },
});
const client = new Client({ name: "flightrules-purge", version: "0.1.0" }, { capabilities: {} });
await client.connect(transport);

const call = async (name, args) => {
  const result = await client.callTool({ name, arguments: { searchContext, ...args } });
  return result.content.map((entry) => entry.text ?? "").join("\n");
};

const parse = (text) => {
  const match = /^\{.*\}$/m.exec(text);
  return match ? JSON.parse(match[0]) : { data: [] };
};

/** Identifier and name fields differ per resource type on the pinned server (SL-056). */
const SWEEPS = [
  ["alert", "signoz_list_alert_rules", {}, "alert", "ruleId", "signoz_delete_alert"],
  ["dashboard", "signoz_list_dashboards", {}, "name", "uuid", "signoz_delete_dashboard"],
  ["saved view", "signoz_list_views", { sourcePage: "traces" }, "name", "id", "signoz_delete_view"],
  [
    "channel",
    "signoz_list_notification_channels",
    {},
    "name",
    "id",
    "signoz_delete_notification_channel",
  ],
];

let removed = 0;
for (const [label, listTool, listArgs, nameField, idField, deleteTool] of SWEEPS) {
  const listed = parse(await call(listTool, listArgs)).data ?? [];
  for (const item of listed) {
    const name = item?.[nameField];
    const id = item?.[idField];
    if (typeof name !== "string" || typeof id !== "string") continue;
    if (!name.startsWith(prefix)) continue;
    await call(deleteTool, { id });
    process.stdout.write(`deleted ${label.padEnd(10)} ${name}\n`);
    removed += 1;
  }
}

process.stdout.write(`${removed} managed artefact(s) deleted for ${projectSlug}\n`);
await client.close();

const databaseUrl = process.env["DATABASE_URL"];
if (!databaseUrl) {
  process.stdout.write(
    "DATABASE_URL is not set, so the artefact register was left alone. " +
      "The next sync will return its cached result until the register is cleared.\n",
  );
  process.exit(0);
}

// Through the product's own connector, so the register is read with the settings the product uses.
const { connect } = await import(new URL("../packages/db/dist/index.js", import.meta.url).href);
const sql = connect(databaseUrl, { max: 1 });
try {
  const [project] = await sql`select id from projects where slug = ${projectSlug}`;
  if (!project) {
    process.stdout.write(`no project "${projectSlug}" in the database; register untouched\n`);
  } else {
    const artefacts = await sql`
      delete from signoz_artifacts where project_id = ${project.id} returning id`;
    const jobs = await sql`
      delete from jobs
      where job_type = 'signoz_sync' and project_id = ${project.id}
      returning id`;
    process.stdout.write(
      `cleared ${artefacts.length} register row(s) and ${jobs.length} sync job(s); ` +
        "the next sync will create and verify from scratch\n",
    );
  }
} finally {
  await sql.end({ timeout: 5 });
}
