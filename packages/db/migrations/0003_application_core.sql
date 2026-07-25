-- migrate:up

-- Phase 09: the remaining thirteen of PRD section 14's sixteen P0 tables.
--
-- `projects`, `signoz_connections` and `audit_events` were created by migration 0001 and are not
-- touched here. Migrations 0001 and 0002 are never edited; this file is forward-only.
--
-- Conventions carried from 0001:
--   * every primary key is `flightrules_uuid_v7()`, which is sortable to one microsecond (0002)
--   * every mutable table carries `updated_at` maintained by `flightrules_touch_updated_at()`
--   * every closed vocabulary is a check constraint, so an invalid lifecycle value is impossible
--     to store even if application code is wrong
--   * a ratio is stored as its exact numerator and denominator plus the truncated decimal the
--     domain packages render, with a check tying the two together, so a percentage can never
--     silently drift from the counts it came from

-- ---------------------------------------------------------------------------
-- 14.3 agents
-- ---------------------------------------------------------------------------

create table agents (
  id uuid primary key default flightrules_uuid_v7(),
  project_id uuid not null references projects (id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 120),
  agent_key text not null check (agent_key ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  workflow_name_matcher text not null check (length(workflow_name_matcher) between 1 and 200),
  root_span_matcher_json jsonb not null default '{}'::jsonb,
  service_matchers_json jsonb not null default '[]'::jsonb,
  -- FR-002 names an optional tool operation matcher and expected trace completion criteria.
  -- PRD section 14.3 does not list a column for either, so they are stored explicitly rather
  -- than smuggled into another column's payload. See ADR-0008.
  tool_operation_matcher_json jsonb,
  completion_criteria_json jsonb not null default '{}'::jsonb,
  -- FR-002: "registration fails if no release discriminator is supplied".
  release_attribute_key text not null check (length(trim(release_attribute_key)) between 1 and 120),
  environment_attribute_key text not null
    check (length(trim(environment_attribute_key)) between 1 and 120),
  normaliser_config_id text not null default 'default'
    check (length(normaliser_config_id) between 1 and 120),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint agents_project_key_unique unique (project_id, agent_key),
  constraint agents_service_matchers_is_array check (jsonb_typeof(service_matchers_json) = 'array'),
  constraint agents_root_matcher_is_object check (jsonb_typeof(root_span_matcher_json) = 'object')
);

create trigger agents_touch
  before update on agents
  for each row execute function flightrules_touch_updated_at();

create index agents_project_idx on agents (project_id, agent_key);

-- ---------------------------------------------------------------------------
-- 14.4 releases
-- ---------------------------------------------------------------------------

create table releases (
  id uuid primary key default flightrules_uuid_v7(),
  agent_id uuid not null references agents (id) on delete cascade,
  release_key text not null check (length(trim(release_key)) between 1 and 200),
  commit_sha text check (commit_sha is null or commit_sha ~ '^[0-9a-f]{7,64}$'),
  image_digest text check (image_digest is null or length(image_digest) between 1 and 200),
  environment text not null check (length(trim(environment)) between 1 and 120),
  first_observed_at timestamptz,
  last_observed_at timestamptz,
  metadata_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint releases_agent_key_unique unique (agent_id, release_key, environment),
  constraint releases_observation_order check (
    first_observed_at is null or last_observed_at is null or last_observed_at >= first_observed_at
  )
);

create trigger releases_touch
  before update on releases
  for each row execute function flightrules_touch_updated_at();

create index releases_agent_idx on releases (agent_id, last_observed_at desc nulls last);

-- ---------------------------------------------------------------------------
-- 14.15 jobs
-- ---------------------------------------------------------------------------
--
-- Created before the tables that reference it, so a baseline, contract or evaluation can name the
-- job that produced it.
--
-- Beyond PRD section 14.15's columns this carries the lease, progress and retry fields PRD section
-- 20.1 requires ("worker restarts resume or safely fail jobs"). PRD section 14 fixes the P0 table
-- set at sixteen, so progress events live here as an append-only array guarded by a monotonic
-- index rather than in a seventeenth table.

create table jobs (
  id uuid primary key default flightrules_uuid_v7(),
  job_type text not null check (
    job_type in ('baseline_mining', 'contract_proposal', 'evaluation', 'demo_run')
  ),
  entity_type text not null check (
    entity_type in ('agent', 'baseline_version', 'contract', 'release', 'project')
  ),
  entity_id uuid,
  project_id uuid references projects (id) on delete cascade,
  status text not null default 'queued' check (
    status in ('queued', 'running', 'succeeded', 'failed', 'cancelled')
  ),
  attempt integer not null default 0 check (attempt >= 0),
  max_attempts integer not null default 3 check (max_attempts between 1 and 20),
  -- PRD sections 18.2 and 20.1. For a baseline this is the miner's `selectionHash`.
  idempotency_key text not null check (length(idempotency_key) between 1 and 200),
  -- Canonical hash of `input_json`, so a repeat submission under one key that means something
  -- different is a conflict rather than a silent reuse of the wrong result.
  input_hash text not null check (input_hash ~ '^[0-9a-f]{64}$'),
  input_json jsonb not null,
  result_json jsonb,
  error_json jsonb,
  progress_index integer not null default 0 check (progress_index >= 0),
  progress_stage text,
  progress_json jsonb not null default '[]'::jsonb
    check (jsonb_typeof(progress_json) = 'array'),
  lease_owner text check (lease_owner is null or length(lease_owner) between 1 and 200),
  lease_expires_at timestamptz,
  heartbeat_at timestamptz,
  available_at timestamptz not null default now(),
  cancel_requested boolean not null default false,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint jobs_idempotency_unique unique (job_type, idempotency_key),
  constraint jobs_terminal_completed check (
    (status in ('succeeded', 'failed', 'cancelled')) = (completed_at is not null)
  ),
  constraint jobs_running_holds_lease check (
    status <> 'running' or (lease_owner is not null and lease_expires_at is not null)
  ),
  constraint jobs_succeeded_has_result check (status <> 'succeeded' or result_json is not null),
  constraint jobs_failed_has_error check (status <> 'failed' or error_json is not null),
  constraint jobs_attempt_bounded check (attempt <= max_attempts)
);

create trigger jobs_touch
  before update on jobs
  for each row execute function flightrules_touch_updated_at();

-- Supports the claim query: the oldest available job of a type. Partial, because only queued rows
-- are ever claimed and the index should not carry the completed history.
create index jobs_claimable_idx on jobs (job_type, available_at, created_at) where status = 'queued';
-- Supports stale-lease recovery.
create index jobs_lease_idx on jobs (lease_expires_at) where status = 'running';
create index jobs_entity_idx on jobs (entity_type, entity_id, created_at desc);
create index jobs_project_idx on jobs (project_id, created_at desc);

-- ---------------------------------------------------------------------------
-- 14.5 trace_runs
-- ---------------------------------------------------------------------------

create table trace_runs (
  id uuid primary key default flightrules_uuid_v7(),
  agent_id uuid not null references agents (id) on delete cascade,
  release_id uuid references releases (id) on delete set null,
  trace_id text not null check (trace_id ~ '^[0-9a-f]{8,64}$'),
  run_id text check (run_id is null or length(run_id) between 1 and 200),
  signoz_web_url text check (
    signoz_web_url is null or signoz_web_url ~ '^https?://'
  ),
  root_span_id text check (root_span_id is null or root_span_id ~ '^[0-9a-z_]{1,64}$'),
  started_at timestamptz not null,
  completed_at timestamptz,
  duration_ms integer check (duration_ms is null or duration_ms >= 0),
  status text not null check (status in ('ok', 'error', 'unknown')),
  quality_status text not null check (
    quality_status in ('complete', 'incomplete', 'inconsistent', 'too_large')
  ),
  raw_summary_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint trace_runs_agent_trace_unique unique (agent_id, trace_id)
);

create index trace_runs_agent_started_idx on trace_runs (agent_id, started_at desc);
create index trace_runs_release_idx on trace_runs (release_id, started_at desc);

-- ---------------------------------------------------------------------------
-- 14.6 trace_graphs
-- ---------------------------------------------------------------------------

create table trace_graphs (
  id uuid primary key default flightrules_uuid_v7(),
  trace_run_id uuid not null references trace_runs (id) on delete cascade,
  normaliser_version text not null check (length(normaliser_version) between 1 and 40),
  normaliser_config_hash text not null check (normaliser_config_hash ~ '^[0-9a-f]{64}$'),
  graph_schema_version text not null check (length(graph_schema_version) between 1 and 40),
  fingerprint text not null check (fingerprint ~ '^[0-9a-f]{64}$'),
  canonical_graph_json jsonb not null,
  feature_set_json jsonb not null,
  quality_warnings_json jsonb not null default '[]'::jsonb
    check (jsonb_typeof(quality_warnings_json) = 'array'),
  created_at timestamptz not null default now(),
  constraint trace_graphs_run_normaliser_unique unique (trace_run_id, normaliser_version)
);

create index trace_graphs_fingerprint_idx on trace_graphs (fingerprint);

-- ---------------------------------------------------------------------------
-- 14.7 baseline_versions
-- ---------------------------------------------------------------------------

create table baseline_versions (
  id uuid primary key default flightrules_uuid_v7(),
  agent_id uuid not null references agents (id) on delete cascade,
  release_id uuid references releases (id) on delete set null,
  environment text,
  status text not null check (
    status in ('dataset_truncated', 'insufficient_runs', 'pending_review', 'approved')
  ),
  source_time_start timestamptz not null,
  source_time_end timestamptz not null,
  minimum_runs integer not null check (minimum_runs > 0),
  rare_threshold_numerator bigint not null check (rare_threshold_numerator >= 0),
  rare_threshold_denominator bigint not null check (rare_threshold_denominator > 0),
  -- The miner's content identity, `bl-<32 hex>`, derived from the selection rather than generated.
  baseline_identifier text not null check (baseline_identifier ~ '^bl-[0-9a-f]{32}$'),
  -- PRD sections 18.2 and 20.1: the idempotency key of the job that produced this row.
  selection_hash text not null check (selection_hash ~ '^[0-9a-f]{64}$'),
  selection_json jsonb not null,
  normaliser_version text not null,
  normaliser_config_hash text not null check (normaliser_config_hash ~ '^[0-9a-f]{64}$'),
  counts_json jsonb not null,
  retrieval_json jsonb not null,
  excluded_json jsonb not null default '[]'::jsonb
    check (jsonb_typeof(excluded_json) = 'array'),
  disclosures_json jsonb not null default '[]'::jsonb
    check (jsonb_typeof(disclosures_json) = 'array'),
  job_id uuid references jobs (id) on delete set null,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint baseline_versions_selection_unique unique (agent_id, selection_hash),
  constraint baseline_versions_identifier_unique unique (baseline_identifier),
  constraint baseline_versions_window_order check (source_time_end > source_time_start),
  constraint baseline_versions_approval check ((status = 'approved') = (approved_at is not null))
);

create trigger baseline_versions_touch
  before update on baseline_versions
  for each row execute function flightrules_touch_updated_at();

create index baseline_versions_agent_idx on baseline_versions (agent_id, created_at desc);

-- ---------------------------------------------------------------------------
-- 14.8 route_families
-- ---------------------------------------------------------------------------

create table route_families (
  id uuid primary key default flightrules_uuid_v7(),
  baseline_version_id uuid not null references baseline_versions (id) on delete cascade,
  family_identifier text not null check (family_identifier ~ '^rf-[0-9a-f]{32}$'),
  fingerprint text not null check (fingerprint ~ '^[0-9a-f]{64}$'),
  canonical_graph_json jsonb not null,
  occurrence_count integer not null check (occurrence_count >= 0),
  occurrence_numerator bigint not null check (occurrence_numerator >= 0),
  occurrence_denominator bigint not null check (occurrence_denominator > 0),
  occurrence_percent numeric(9, 6) not null check (occurrence_percent between 0 and 1),
  rare boolean not null default false,
  status text not null check (
    status in ('pending', 'approved', 'rejected', 'optional', 'excluded_fixture_error')
  ),
  representative_trace_ids_json jsonb not null default '[]'::jsonb
    check (jsonb_typeof(representative_trace_ids_json) = 'array'),
  statistics_json jsonb not null,
  normaliser_version text not null,
  normaliser_config_hash text not null check (normaliser_config_hash ~ '^[0-9a-f]{64}$'),
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint route_families_baseline_fingerprint_unique unique (baseline_version_id, fingerprint),
  constraint route_families_identifier_unique unique (family_identifier),
  -- The stored percentage is exactly the truncated integer division the domain package renders.
  constraint route_families_percent_matches_counts check (
    occurrence_percent
      = trunc(occurrence_numerator::numeric * 1000000 / occurrence_denominator::numeric) / 1000000
  ),
  constraint route_families_decision_timestamp check ((status = 'pending') = (decided_at is null))
);

create trigger route_families_touch
  before update on route_families
  for each row execute function flightrules_touch_updated_at();

create index route_families_baseline_idx on route_families (baseline_version_id, fingerprint);
create index route_families_fingerprint_idx on route_families (fingerprint);

-- ---------------------------------------------------------------------------
-- 14.9 contracts
-- ---------------------------------------------------------------------------

create table contracts (
  id uuid primary key default flightrules_uuid_v7(),
  agent_id uuid not null references agents (id) on delete cascade,
  baseline_version_id uuid references baseline_versions (id) on delete set null,
  name text not null check (length(trim(name)) between 1 and 200),
  -- `metadata.id` from the contract document, which the evaluator stamps onto every result.
  contract_key text not null check (contract_key ~ '^[a-z0-9][a-z0-9._-]{0,127}$'),
  semantic_version text not null check (semantic_version ~ '^[0-9]+\.[0-9]+\.[0-9]+$'),
  schema_version text not null check (length(schema_version) between 1 and 60),
  environment text not null check (length(trim(environment)) between 1 and 120),
  -- PRD FR-018 plus PRD section 8.9's `Invalid`.
  status text not null check (
    status in ('draft', 'approved', 'active', 'superseded', 'invalid')
  ),
  source text not null default 'authored' check (source in ('authored', 'mined')),
  yaml_text text not null,
  canonical_json jsonb not null,
  content_hash text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  validation_errors_json jsonb not null default '[]'::jsonb
    check (jsonb_typeof(validation_errors_json) = 'array'),
  job_id uuid references jobs (id) on delete set null,
  approved_at timestamptz,
  activated_at timestamptz,
  superseded_at timestamptz,
  superseded_by_contract_id uuid references contracts (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint contracts_version_unique unique (agent_id, contract_key, semantic_version, environment),
  constraint contracts_approved_timestamp check (
    status in ('draft', 'invalid') or approved_at is not null
  ),
  constraint contracts_activated_timestamp check (
    status in ('draft', 'invalid', 'approved') or activated_at is not null
  ),
  constraint contracts_superseded_timestamp check (
    (status = 'superseded') = (superseded_at is not null)
  ),
  constraint contracts_invalid_has_errors check (
    status <> 'invalid' or jsonb_array_length(validation_errors_json) > 0
  ),
  constraint contracts_not_self_superseding check (superseded_by_contract_id <> id)
);

create trigger contracts_touch
  before update on contracts
  for each row execute function flightrules_touch_updated_at();

-- FR-018: activating a version supersedes the prior active version for the same agent and
-- environment. One active contract per pair, enforced by the database rather than by a read.
create unique index contracts_one_active_per_environment
  on contracts (agent_id, environment) where status = 'active';

create index contracts_agent_idx on contracts (agent_id, created_at desc);
create index contracts_hash_idx on contracts (content_hash);

-- ---------------------------------------------------------------------------
-- 14.10 contract_rules
-- ---------------------------------------------------------------------------

create table contract_rules (
  id uuid primary key default flightrules_uuid_v7(),
  contract_id uuid not null references contracts (id) on delete cascade,
  rule_key text not null check (length(rule_key) between 1 and 128),
  rule_type text not null check (
    rule_type in (
      'required_span', 'required_ancestry', 'required_edge', 'forbidden_span', 'forbidden_path',
      'cardinality', 'allowed_values', 'attribute_constraint', 'retry_budget', 'approved_routes',
      'numeric_budget'
    )
  ),
  severity text not null check (severity in ('low', 'medium', 'high', 'critical')),
  zero_tolerance boolean not null default false,
  rule_json jsonb not null,
  -- FR-008: every proposed rule carries its evidence basis. Null for a hand-authored rule.
  evidence_basis_json jsonb,
  created_at timestamptz not null default now(),
  constraint contract_rules_key_unique unique (contract_id, rule_key)
);

create index contract_rules_contract_idx on contract_rules (contract_id, rule_key);

-- ---------------------------------------------------------------------------
-- 14.11 evaluations
-- ---------------------------------------------------------------------------

create table evaluations (
  id uuid primary key default flightrules_uuid_v7(),
  agent_id uuid not null references agents (id) on delete cascade,
  contract_id uuid not null references contracts (id) on delete cascade,
  release_id uuid references releases (id) on delete set null,
  scope text not null check (scope in ('run', 'release')),
  status text not null check (
    status in ('queued', 'running', 'pass', 'fail', 'error', 'insufficient_data')
  ),
  evaluator_version text not null check (length(evaluator_version) between 1 and 40),
  normaliser_version text not null check (length(normaliser_version) between 1 and 40),
  normaliser_config_hash text not null check (normaliser_config_hash ~ '^[0-9a-f]{64}$'),
  contract_content_hash text not null check (contract_content_hash ~ '^[0-9a-f]{64}$'),
  idempotency_key text not null check (idempotency_key ~ '^[0-9a-f]{64}$'),
  window_start timestamptz,
  window_end timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  summary_json jsonb not null default '{}'::jsonb,
  job_id uuid references jobs (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint evaluations_idempotency_unique unique (contract_id, scope, idempotency_key),
  constraint evaluations_window_order check (
    window_start is null or window_end is null or window_end > window_start
  ),
  constraint evaluations_terminal_completed check (
    (status in ('pass', 'fail', 'error', 'insufficient_data')) = (completed_at is not null)
  )
);

create trigger evaluations_touch
  before update on evaluations
  for each row execute function flightrules_touch_updated_at();

create index evaluations_agent_idx on evaluations (agent_id, created_at desc);
create index evaluations_release_idx on evaluations (release_id, created_at desc);
create index evaluations_contract_idx on evaluations (contract_id, created_at desc);

-- ---------------------------------------------------------------------------
-- 14.12 run_evaluations
-- ---------------------------------------------------------------------------

create table run_evaluations (
  id uuid primary key default flightrules_uuid_v7(),
  evaluation_id uuid not null references evaluations (id) on delete cascade,
  trace_run_id uuid not null references trace_runs (id) on delete cascade,
  status text not null check (status in ('pass', 'fail', 'error', 'insufficient_data')),
  nearest_route_family_id uuid references route_families (id) on delete set null,
  similarity_numerator bigint not null check (similarity_numerator >= 0),
  similarity_denominator bigint not null check (similarity_denominator > 0),
  similarity_score numeric(9, 6) not null check (similarity_score between 0 and 1),
  route_fingerprint text not null check (route_fingerprint ~ '^[0-9a-f]{64}$'),
  route_approved boolean not null,
  -- SHA-256 over the canonical evaluation, excluding runtime metadata (PRD section 11.12).
  evaluation_hash text not null check (evaluation_hash ~ '^[0-9a-f]{64}$'),
  result_json jsonb not null,
  created_at timestamptz not null default now(),
  constraint run_evaluations_unique unique (evaluation_id, trace_run_id),
  constraint run_evaluations_similarity_matches_counts check (
    similarity_score
      = trunc(similarity_numerator::numeric * 1000000 / similarity_denominator::numeric) / 1000000
  )
);

create index run_evaluations_evaluation_idx on run_evaluations (evaluation_id, created_at);
create index run_evaluations_trace_idx on run_evaluations (trace_run_id);

-- ---------------------------------------------------------------------------
-- 14.13 violations
-- ---------------------------------------------------------------------------

create table violations (
  id uuid primary key default flightrules_uuid_v7(),
  run_evaluation_id uuid not null references run_evaluations (id) on delete cascade,
  -- The evaluator's stable violation identity: derived from the rule, the code and the canonical
  -- evidence, never from span IDs, so the same finding in two runs carries one key.
  violation_key text not null check (length(violation_key) between 1 and 200),
  rule_key text not null check (length(rule_key) between 1 and 128),
  rule_type text not null check (
    rule_type in (
      'required_span', 'required_ancestry', 'required_edge', 'forbidden_span', 'forbidden_path',
      'cardinality', 'allowed_values', 'attribute_constraint', 'retry_budget', 'approved_routes',
      'numeric_budget'
    )
  ),
  violation_type text not null check (
    violation_type in (
      'REQUIRED_SPAN_MISSING', 'REQUIRED_SPAN_TOO_MANY', 'REQUIRED_ANCESTRY_MISSING',
      'REQUIRED_EDGE_MISSING', 'FORBIDDEN_SPAN_PRESENT', 'FORBIDDEN_PATH_PRESENT',
      'CARDINALITY_BELOW_MIN', 'CARDINALITY_ABOVE_MAX', 'DISALLOWED_VALUE',
      'ATTRIBUTE_CONSTRAINT_FAILED', 'RETRY_BUDGET_PER_TOOL_EXCEEDED',
      'RETRY_BUDGET_RUN_TOTAL_EXCEEDED', 'RETRY_BUDGET_SIDE_EFFECT_EXCEEDED',
      'ROUTE_NOT_APPROVED', 'ROUTE_DRIFTED', 'NUMERIC_BUDGET_EXCEEDED'
    )
  ),
  severity text not null check (severity in ('low', 'medium', 'high', 'critical')),
  zero_tolerance boolean not null default false,
  message text not null check (length(message) between 1 and 2000),
  expected text not null default '',
  observed text not null default '',
  evidence_json jsonb not null,
  signoz_web_url text check (signoz_web_url is null or signoz_web_url ~ '^https?://'),
  created_at timestamptz not null default now(),
  constraint violations_key_unique unique (run_evaluation_id, violation_key)
);

create index violations_run_evaluation_idx on violations (run_evaluation_id);
create index violations_severity_idx on violations (severity, created_at desc);
create index violations_rule_idx on violations (rule_key, created_at desc);

-- ---------------------------------------------------------------------------
-- 14.14 signoz_artifacts
-- ---------------------------------------------------------------------------

create table signoz_artifacts (
  id uuid primary key default flightrules_uuid_v7(),
  project_id uuid not null references projects (id) on delete cascade,
  agent_id uuid references agents (id) on delete cascade,
  artifact_type text not null check (
    artifact_type in ('saved_view', 'dashboard', 'alert', 'notification_channel')
  ),
  managed_name text not null check (length(managed_name) between 1 and 200),
  signoz_resource_id text,
  signoz_web_url text check (signoz_web_url is null or signoz_web_url ~ '^https?://'),
  spec_hash text not null check (spec_hash ~ '^[0-9a-f]{64}$'),
  last_synced_at timestamptz,
  last_verified_at timestamptz,
  status text not null default 'pending' check (
    status in ('pending', 'synced', 'drifted', 'failed', 'deleted')
  ),
  remote_snapshot_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint signoz_artifacts_managed_name_unique unique (project_id, managed_name)
);

create trigger signoz_artifacts_touch
  before update on signoz_artifacts
  for each row execute function flightrules_touch_updated_at();

create index signoz_artifacts_project_idx on signoz_artifacts (project_id, artifact_type);

-- migrate:down

drop table if exists signoz_artifacts;
drop table if exists violations;
drop table if exists run_evaluations;
drop table if exists evaluations;
drop table if exists contract_rules;
drop table if exists contracts;
drop table if exists route_families;
drop table if exists baseline_versions;
drop table if exists trace_graphs;
drop table if exists trace_runs;
drop table if exists jobs;
drop table if exists releases;
drop table if exists agents;
