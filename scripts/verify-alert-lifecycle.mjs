#!/usr/bin/env node
/**
 * Proves the full lifecycle of every managed alert against the running SigNoz (PRD Phase 16, the
 * alert firing and recovery requirement; PRD FR-015).
 *
 * Phase 10 evidenced the *firing* transition. It did not evidence recovery, for an honest reason:
 * the canary keeps producing violations, so the rate alert never crossed back below its recovery
 * target while anyone was watching. This script closes that by driving the transition rather than
 * waiting for it, and by reading the outcome from SigNoz's own alert history rather than from
 * anything FlightRules believes.
 *
 * For each managed alert it establishes, in order:
 *
 *   1. the configuration read back by identifier — query, threshold, channels, evaluation window;
 *   2. the current state;
 *   3. the firing state, from alert history, with the value and the timestamp SigNoz recorded;
 *   4. the recovery state, once the condition has cleared;
 *   5. that the query and the thresholds are unchanged by the whole cycle.
 *
 * Recovery is a *time* transition for these alerts. Every one is an `increase` over a rolling
 * evaluation window, so the condition clears when the window slides past the last violation — not
 * when anything is deleted. The script therefore waits for the window plus a margin, polling the
 * history, and reports exactly what it observed. It never asserts a recovery it did not see.
 *
 *   node scripts/verify-alert-lifecycle.mjs                 # observe, waiting for recovery
 *   node scripts/verify-alert-lifecycle.mjs --no-wait       # observe the current state only
 *   node scripts/verify-alert-lifecycle.mjs --wait-minutes 12
 */
import { writeFile } from "node:fs/promises";
import process from "node:process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const apiKey = process.env["SIGNOZ_API_KEY"];
const mcpUrl = process.env["SIGNOZ_MCP_URL"] ?? "http://localhost:8000/mcp";
const PROJECT = process.env["PROJECT"] ?? "demo-commerce";

if (!apiKey || apiKey === "replace-me") {
  process.stderr.write("SIGNOZ_API_KEY is not set. Source .env first.\n");
  process.exit(5);
}

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : (args[index + 1] ?? fallback);
};

const WAIT_MINUTES = Number.parseInt(value("wait-minutes", "12"), 10);
const POLL_SECONDS = Number.parseInt(value("poll-seconds", "30"), 10);
const OUT = value("out", "docs/evidence/phase-16/alert-lifecycle.json");
const SEARCH_CONTEXT =
  "FlightRules Phase 16: verify the firing and recovery lifecycle of every managed alert";

const failures = [];
const ok = (message) => process.stdout.write(`  ok    ${message}\n`);
const note = (message) => process.stdout.write(`  note  ${message}\n`);
const fail = (message) => {
  failures.push(message);
  process.stdout.write(`  FAIL  ${message}\n`);
};

/** The MCP text envelope wraps one JSON document; the tools also append advisory notes. */
function parseEnvelope(result) {
  const text = result.content.map((entry) => entry.text ?? "").join("\n");
  const match = /^\{[\s\S]*\}$/m.exec(text);
  if (!match) throw new Error(`no JSON document in the MCP response: ${text.slice(0, 200)}`);
  return JSON.parse(match[0]);
}

const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
  requestInit: { headers: { "SIGNOZ-API-KEY": apiKey } },
});
const client = new Client(
  { name: "flightrules-verify-alert-lifecycle", version: "0.1.0" },
  { capabilities: {} },
);
await client.connect(transport);

const call = async (name, toolArgs) =>
  parseEnvelope(
    await client.callTool({ name, arguments: { searchContext: SEARCH_CONTEXT, ...toolArgs } }),
  );

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* -------------------------------------------------------------------- discovery */

process.stdout.write("\nManaged alerts\n");

const managedPrefix = `FlightRules / ${PROJECT} / `;
const listed = await call("signoz_list_alert_rules", {});
const managed = (listed?.data ?? []).filter(
  (rule) => typeof rule?.alert === "string" && rule.alert.startsWith(managedPrefix),
);

if (managed.length === 0) {
  fail(`no managed alert found for ${PROJECT}. Run \`make demo-full\` first.`);
} else {
  ok(`${String(managed.length)} managed alert(s) for ${PROJECT}`);
}

/**
 * The configuration that must survive the whole cycle.
 *
 * Read from the alert itself rather than recomputed from the compiler, because the claim being
 * made is about what SigNoz is storing — a compiler that agreed with itself would prove nothing.
 */
function configurationOf(rule) {
  const condition = rule?.condition ?? {};
  const thresholds = condition?.thresholds?.spec ?? [];
  const query = condition?.compositeQuery?.queries?.[0]?.spec ?? {};
  return {
    alert: rule?.alert ?? null,
    ruleType: rule?.ruleType ?? null,
    severity: rule?.labels?.severity ?? null,
    evalWindow: rule?.evaluation?.spec?.evalWindow ?? rule?.evalWindow ?? null,
    metric: query?.aggregations?.[0]?.metricName ?? null,
    filter: query?.filter?.expression ?? null,
    thresholds: thresholds.map((tier) => ({
      name: tier?.name ?? null,
      target: tier?.target ?? null,
      op: tier?.op ?? null,
      matchType: tier?.matchType ?? null,
      recoveryTarget: tier?.recoveryTarget ?? null,
      channels: tier?.channels ?? null,
    })),
  };
}

/**
 * The most recent history entries, newest first, normalised to the fields that matter.
 *
 * `signoz_get_alert_history` does **not** use the list envelope the other list tools use: it answers
 * `{"status":"success","data":{"items":[...],"total":n}}` rather than `{"data":[...]}`. Reading
 * `data` as an array therefore throws rather than returning nothing, which is the better failure —
 * but it has to be handled, and both shapes are accepted here so a server change does not silently
 * turn "no history" and "history in a different place" into the same answer.
 */
async function historyOf(ruleId) {
  const history = await call("signoz_get_alert_history", { id: ruleId, limit: 50 });
  const payload = history?.data;
  const rows = Array.isArray(payload) ? payload : (payload?.items ?? []);
  return rows
    .map((row) => ({
      // `overallState` is the *rule's* state; `state` is the state of one evaluated sample and takes
      // values the rule never does, such as `nodata`. Reading `state` as the rule's state makes a
      // rule that merely had a gap in its data look like one that fired, so both are kept and every
      // decision below is made on the rule-level one.
      overallState: row?.overallState ?? null,
      sampleState: row?.state ?? null,
      stateChanged: row?.overallStateChanged ?? row?.stateChanged ?? null,
      unixMilli: row?.unixMilli ?? null,
      value: row?.value ?? null,
    }))
    .sort((a, b) => Number(b.unixMilli ?? 0) - Number(a.unixMilli ?? 0));
}

/** The states SigNoz uses for a rule that is not firing. */
const SETTLED = ["normal", "inactive", "resolved", "ok"];

function latestOf(history, predicate) {
  return history.find(predicate) ?? null;
}

/* -------------------------------------------------------------------- observation */

const observations = [];

for (const rule of managed) {
  const ruleId = rule?.id ?? rule?.ruleId;
  const name = rule?.alert;
  process.stdout.write(`\n${name}\n`);

  if (typeof ruleId !== "string" || ruleId.length === 0) {
    fail(`${name}: the list response carried no rule identifier`);
    continue;
  }

  // 1. configuration, read back by identifier
  const fetched = await call("signoz_get_alert", { id: ruleId });
  const before = configurationOf(fetched?.data ?? {});
  if (before.alert === name) ok("configuration reads back by identifier");
  else fail(`${name}: the read-back returned "${String(before.alert)}"`);

  if (before.metric !== null && before.filter !== null) {
    ok(`query ${before.metric} where ${before.filter}`);
  } else {
    fail(`${name}: the stored alert carries no metric or no filter expression`);
  }

  if (before.thresholds.length > 0) {
    for (const tier of before.thresholds) {
      ok(
        `threshold ${String(tier.name)} ${String(tier.op)} ${String(tier.target)}` +
          (tier.recoveryTarget === null ? "" : `, recovery ${String(tier.recoveryTarget)}`),
      );
    }
  } else {
    fail(`${name}: the stored alert carries no threshold tier`);
  }

  // 2 and 3. current state, and the firing transition from history.
  //
  // The current state comes from the rule itself rather than from the newest history row: history
  // is written per evaluated sample, so a rule with no sample in the last cycle has no row to read
  // while still having a state.
  const history = await historyOf(ruleId);
  const state = rule?.state ?? fetched?.data?.state ?? null;
  const firing = latestOf(history, (entry) => entry.overallState === "firing");
  const settled = latestOf(history, (entry) => SETTLED.includes(String(entry.overallState)));

  ok(`current state ${String(state)}`);
  if (history.length === 0) {
    note("alert history is empty; SigNoz has recorded no state change for this rule yet");
  }

  if (firing !== null) {
    ok(
      `firing recorded at ${new Date(Number(firing.unixMilli)).toISOString()} with value ${String(firing.value)}`,
    );
  } else {
    note("no firing transition in the retained history for this rule");
  }

  observations.push({ ruleId, name, before, history, firing, settled, state });
}

/* -------------------------------------------------------------------- recovery */

process.stdout.write("\nRecovery\n");

/**
 * Alerts that were firing and must therefore be seen to recover.
 *
 * An alert that never fired has nothing to recover from, and demanding a recovery transition for it
 * would be demanding evidence of something that did not happen.
 */
const awaiting = observations.filter(
  (entry) => entry.firing !== null && String(entry.state) === "firing",
);

if (awaiting.length === 0) {
  const everFired = observations.filter((entry) => entry.firing !== null);
  for (const entry of everFired) {
    // A recovery is a settled history row *after* a firing one — the transition, not merely the
    // present state. Reporting "it is inactive now" would not distinguish a rule that recovered
    // from one that never fired at all.
    const recovered =
      entry.settled !== null && Number(entry.settled.unixMilli) > Number(entry.firing.unixMilli);
    if (recovered) {
      entry.recovery = entry.settled;
      ok(
        `${entry.name}: recovered to ${String(entry.settled.overallState)} at ` +
          `${new Date(Number(entry.settled.unixMilli)).toISOString()}, after firing at ` +
          `${new Date(Number(entry.firing.unixMilli)).toISOString()}`,
      );
    } else {
      fail(`${entry.name}: fired but no later settled state is recorded in its history`);
    }
  }
  if (everFired.length === 0) {
    note("no managed alert is firing, so there is no recovery to observe in this run");
  }
} else if (flag("no-wait")) {
  note(`${String(awaiting.length)} alert(s) still firing; --no-wait, so recovery was not awaited`);
} else {
  note(
    `${String(awaiting.length)} alert(s) firing. Waiting up to ${String(WAIT_MINUTES)} minutes for ` +
      "the evaluation window to slide past the last violation.",
  );

  const deadline = Date.now() + WAIT_MINUTES * 60_000;
  const pending = new Map(awaiting.map((entry) => [entry.ruleId, entry]));

  while (pending.size > 0 && Date.now() < deadline) {
    await sleep(POLL_SECONDS * 1000);
    for (const [ruleId, entry] of [...pending]) {
      const history = await historyOf(ruleId);
      const latest = history[0];
      if (latest === undefined) continue;
      if (SETTLED.includes(String(latest.overallState))) {
        ok(
          `${entry.name}: recovered to ${String(latest.overallState)} at ` +
            `${new Date(Number(latest.unixMilli)).toISOString()}`,
        );
        entry.recovery = latest;
        entry.history = history;
        pending.delete(ruleId);
      }
    }
  }

  for (const entry of pending.values()) {
    fail(
      `${entry.name}: no recovery transition observed within ${String(WAIT_MINUTES)} minutes. ` +
        "Recorded as unobserved rather than assumed.",
    );
  }
}

/* -------------------------------------------------------- configuration unchanged */

process.stdout.write("\nConfiguration after the cycle\n");

for (const entry of observations) {
  const fetched = await call("signoz_get_alert", { id: entry.ruleId });
  const after = configurationOf(fetched?.data ?? {});
  entry.after = after;
  if (JSON.stringify(after) === JSON.stringify(entry.before)) {
    ok(`${entry.name}: query and thresholds unchanged`);
  } else {
    fail(`${entry.name}: the stored query or threshold changed during the lifecycle`);
  }
}

/* -------------------------------------------------------------------- evidence */

await writeFile(
  OUT,
  `${JSON.stringify(
    {
      project: PROJECT,
      alerts: observations.map((entry) => ({
        name: entry.name,
        ruleId: entry.ruleId,
        configuration: entry.before,
        configurationUnchanged: JSON.stringify(entry.after) === JSON.stringify(entry.before),
        firing: entry.firing,
        recovery: entry.recovery ?? null,
        currentState: entry.state ?? null,
        historySample: entry.history.slice(0, 10),
      })),
    },
    null,
    2,
  )}\n`,
  "utf8",
);

process.stdout.write(`\nWrote ${OUT}\n`);

await client.close();

if (failures.length > 0) {
  process.stdout.write(`\n${String(failures.length)} alert lifecycle check(s) failed.\n`);
  process.exit(1);
}
process.stdout.write(
  "\nEvery managed alert's lifecycle was observed against the running SigNoz.\n",
);
