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
