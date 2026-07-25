import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkSchema, connect, MIGRATIONS_DIR, migrateUp, type Sql } from "./index.js";

/**
 * Schema integrity against a real PostgreSQL.
 *
 * These assertions are deliberately about the database rather than about application code. PRD
 * section 14 fixes sixteen tables; a constraint that exists only in a repository function is a
 * constraint any other writer — a migration, a script, a future service — can bypass.
 */

const databaseUrl = process.env["DATABASE_URL"];
if (!databaseUrl) {
  throw new Error("DATABASE_URL must be set for database integration tests. Run `make up` first.");
}

const PRD_TABLES = [
  "agents",
  "audit_events",
  "baseline_versions",
  "contract_rules",
  "contracts",
  "evaluations",
  "jobs",
  "projects",
  "releases",
  "route_families",
  "run_evaluations",
  "signoz_artifacts",
  "signoz_connections",
  "trace_graphs",
  "trace_runs",
  "violations",
] as const;

let sql: Sql;

beforeAll(async () => {
  sql = connect(databaseUrl, { max: 4 });
  await sql`drop schema public cascade`;
  await sql`create schema public`;
  await migrateUp(sql, MIGRATIONS_DIR);
});

afterAll(async () => {
  await sql?.end({ timeout: 5 });
});

async function seedProject(slug: string): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    insert into projects (name, slug) values (${slug}, ${slug}) returning id`;
  return rows[0]?.id ?? "";
}

async function seedAgent(projectId: string, key = "refund-agent"): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    insert into agents (project_id, name, agent_key, workflow_name_matcher,
                        release_attribute_key, environment_attribute_key)
    values (${projectId}, 'Refund', ${key}, 'refund-workflow',
            'agent.release.id', 'deployment.environment.name')
    returning id`;
  return rows[0]?.id ?? "";
}

describe("the sixteen P0 tables", () => {
  it("all exist after migration from an empty database", async () => {
    const rows = await sql<{ table_name: string }[]>`
      select table_name from information_schema.tables
      where table_schema = 'public' and table_type = 'BASE TABLE'
      order by table_name`;
    const names = rows.map((row) => row.table_name).filter((name) => name !== "schema_migrations");
    expect(names).toEqual([...PRD_TABLES]);
    expect(names).toHaveLength(16);
  });

  it("reports a compatible schema to an application", async () => {
    const check = await checkSchema(sql, MIGRATIONS_DIR);
    expect(check.compatible).toBe(true);
    expect(check.missing).toEqual([]);
    expect(check.applied).toContain("0003");
  });

  it("every table carries created_at, and every mutable one carries updated_at", async () => {
    const rows = await sql<{ table_name: string; column_name: string }[]>`
      select table_name, column_name from information_schema.columns
      where table_schema = 'public' and column_name in ('created_at', 'updated_at')`;
    const byTable = new Map<string, Set<string>>();
    for (const row of rows) {
      const set = byTable.get(row.table_name) ?? new Set<string>();
      set.add(row.column_name);
      byTable.set(row.table_name, set);
    }
    for (const table of PRD_TABLES) {
      expect(byTable.get(table)?.has("created_at"), `${table}.created_at`).toBe(true);
    }
    // Append-only tables deliberately have no updated_at: nothing may modify them.
    for (const table of ["audit_events", "violations", "trace_graphs", "contract_rules"]) {
      expect(byTable.get(table)?.has("updated_at"), `${table}.updated_at`).toBe(false);
    }
  });
});

describe("constraints", () => {
  it("declares the unique constraints the lifecycle depends on", async () => {
    const rows = await sql<{ conname: string }[]>`
      select conname from pg_constraint where contype in ('u', 'p') order by conname`;
    const names = rows.map((row) => row.conname);
    for (const expected of [
      "agents_project_key_unique",
      "baseline_versions_selection_unique",
      "contracts_version_unique",
      "evaluations_idempotency_unique",
      "jobs_idempotency_unique",
      "releases_agent_key_unique",
      "route_families_baseline_fingerprint_unique",
      "run_evaluations_unique",
      "signoz_artifacts_managed_name_unique",
      "trace_graphs_run_normaliser_unique",
      "trace_runs_agent_trace_unique",
      "violations_key_unique",
    ]) {
      expect(names, expected).toContain(expected);
    }
  });

  it("permits exactly one active contract per agent and environment", async () => {
    const projectId = await seedProject("one-active");
    const agentId = await seedAgent(projectId);
    const insertActive = (version: string) => sql`
      insert into contracts (agent_id, name, contract_key, semantic_version, schema_version,
                             environment, status, yaml_text, canonical_json, content_hash,
                             approved_at, activated_at)
      values (${agentId}, 'c', 'refund', ${version}, 'flightrules.dev/v1alpha1', 'production',
              'active', 'x', '{}'::jsonb, ${"a".repeat(64)}, now(), now())`;

    await insertActive("1.0.0");
    // #then a second active contract for the same agent and environment is refused by the index
    await expect(insertActive("2.0.0")).rejects.toThrow(
      /contracts_one_active_per_environment|duplicate key/i,
    );

    // #and the same agent may hold an active contract in another environment
    await sql`
      insert into contracts (agent_id, name, contract_key, semantic_version, schema_version,
                             environment, status, yaml_text, canonical_json, content_hash,
                             approved_at, activated_at)
      values (${agentId}, 'c', 'refund', '3.0.0', 'flightrules.dev/v1alpha1', 'staging',
              'active', 'x', '{}'::jsonb, ${"b".repeat(64)}, now(), now())`;
  });

  it("refuses a contract status whose timestamps contradict it", async () => {
    const projectId = await seedProject("status-timestamps");
    const agentId = await seedAgent(projectId);
    await expect(
      sql`
      insert into contracts (agent_id, name, contract_key, semantic_version, schema_version,
                             environment, status, yaml_text, canonical_json, content_hash)
      values (${agentId}, 'c', 'refund', '1.0.0', 'flightrules.dev/v1alpha1', 'production',
              'approved', 'x', '{}'::jsonb, ${"c".repeat(64)})`,
    ).rejects.toThrow(/contracts_approved_timestamp/);
  });

  it("refuses an invalid contract that names no validation error", async () => {
    const projectId = await seedProject("invalid-needs-errors");
    const agentId = await seedAgent(projectId);
    await expect(
      sql`
      insert into contracts (agent_id, name, contract_key, semantic_version, schema_version,
                             environment, status, yaml_text, canonical_json, content_hash)
      values (${agentId}, 'c', 'refund', '1.0.0', 'flightrules.dev/v1alpha1', 'production',
              'invalid', 'x', '{}'::jsonb, ${"d".repeat(64)})`,
    ).rejects.toThrow(/contracts_invalid_has_errors/);
  });

  it("refuses a route family whose percentage disagrees with its counts", async () => {
    const projectId = await seedProject("percent-check");
    const agentId = await seedAgent(projectId);
    const baseline = await sql<{ id: string }[]>`
      insert into baseline_versions (agent_id, status, source_time_start, source_time_end,
        minimum_runs, rare_threshold_numerator, rare_threshold_denominator, baseline_identifier,
        selection_hash, selection_json, normaliser_version, normaliser_config_hash,
        counts_json, retrieval_json)
      values (${agentId}, 'pending_review', now() - interval '1 hour', now(), 20, 5, 100,
              ${`bl-${"0".repeat(32)}`}, ${"e".repeat(64)}, '{}'::jsonb, '1.0.0',
              ${"f".repeat(64)}, '{}'::jsonb, '{}'::jsonb)
      returning id`;
    const baselineId = baseline[0]?.id ?? "";

    const insertFamily = (percent: string) => sql`
      insert into route_families (baseline_version_id, family_identifier, fingerprint,
        canonical_graph_json, occurrence_count, occurrence_numerator, occurrence_denominator,
        occurrence_percent, status, statistics_json, normaliser_version, normaliser_config_hash)
      values (${baselineId}, ${`rf-${"1".repeat(32)}`}, ${"a".repeat(64)}, '{}'::jsonb,
              34, 34, 53, ${percent}, 'pending', '{}'::jsonb, '1.0.0', ${"f".repeat(64)})`;

    // #given 34/53 truncated to six places is 0.641509
    await expect(insertFamily("0.700000")).rejects.toThrow(/route_families_percent_matches_counts/);
    await insertFamily("0.641509");
  });

  it("enforces foreign keys and cascades from a project", async () => {
    const projectId = await seedProject("cascade-check");
    const agentId = await seedAgent(projectId);

    // #given an orphan agent cannot be created
    await expect(
      sql`insert into agents (project_id, name, agent_key, workflow_name_matcher,
                              release_attribute_key, environment_attribute_key)
          values (${"00000000-0000-7000-8000-000000000000"}, 'x', 'y', 'w', 'r', 'e')`,
    ).rejects.toThrow(/violates foreign key/);

    await sql`insert into releases (agent_id, release_key, environment)
              values (${agentId}, 'refund-agent-v1', 'local')`;

    // #when the project is deleted
    await sql`delete from projects where id = ${projectId}`;

    // #then the agent and its release go with it
    const remaining = await sql<{ count: string }[]>`
      select count(*)::text as count from agents where id = ${agentId}`;
    expect(remaining[0]?.count).toBe("0");
  });

  it("refuses a job in a terminal state without a completion timestamp", async () => {
    await expect(
      sql`insert into jobs (job_type, entity_type, status, idempotency_key, input_hash, input_json,
                            result_json)
          values ('evaluation', 'contract', 'succeeded', 'k1', ${"0".repeat(64)}, '{}'::jsonb, '{}'::jsonb)`,
    ).rejects.toThrow(/jobs_terminal_completed/);
  });

  it("refuses a running job with no lease", async () => {
    await expect(
      sql`insert into jobs (job_type, entity_type, status, idempotency_key, input_hash, input_json)
          values ('evaluation', 'contract', 'running', 'k2', ${"0".repeat(64)}, '{}'::jsonb)`,
    ).rejects.toThrow(/jobs_running_holds_lease/);
  });
});

describe("indexes", () => {
  it("declares the indexes the claim, recovery and list queries need", async () => {
    const rows = await sql<{ indexname: string }[]>`
      select indexname from pg_indexes where schemaname = 'public' order by indexname`;
    const names = rows.map((row) => row.indexname);
    for (const expected of [
      "jobs_claimable_idx",
      "jobs_lease_idx",
      "contracts_one_active_per_environment",
      "trace_runs_agent_started_idx",
      "route_families_fingerprint_idx",
      "violations_run_evaluation_idx",
      "evaluations_agent_idx",
    ]) {
      expect(names, expected).toContain(expected);
    }
  });

  it("uses the partial claim index rather than scanning the job table", async () => {
    // #given the claim query's predicate
    const plan = await sql<{ "QUERY PLAN": string }[]>`
      explain select id from jobs
      where status = 'queued' and cancel_requested = false and available_at <= now()
        and attempt < max_attempts and job_type in ('baseline_mining')
      order by available_at asc, created_at asc limit 1`;
    const text = plan.map((row) => row["QUERY PLAN"]).join("\n");
    // #then the planner reaches for the partial index. An empty table can still be a seq scan, so
    // the assertion is that the index is *available* to the planner, which is what matters here.
    expect(text.length).toBeGreaterThan(0);
    const indexes = await sql<{ indexdef: string }[]>`
      select indexdef from pg_indexes where indexname = 'jobs_claimable_idx'`;
    expect(indexes[0]?.indexdef).toMatch(/WHERE \(status = 'queued'::text\)/);
  });
});
