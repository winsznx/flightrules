# Phase 09 schema inventory

Generated from the live database after migration 0003.

## Columns

```text
agents | id | uuid | not null
agents | project_id | uuid | not null
agents | name | text | not null
agents | agent_key | text | not null
agents | workflow_name_matcher | text | not null
agents | root_span_matcher_json | jsonb | not null
agents | service_matchers_json | jsonb | not null
agents | tool_operation_matcher_json | jsonb | null
agents | completion_criteria_json | jsonb | not null
agents | release_attribute_key | text | not null
agents | environment_attribute_key | text | not null
agents | normaliser_config_id | text | not null
agents | created_at | timestamp with time zone | not null
agents | updated_at | timestamp with time zone | not null
audit_events | id | uuid | not null
audit_events | project_id | uuid | null
audit_events | actor_type | text | not null
audit_events | actor_id | text | not null
audit_events | event_type | text | not null
audit_events | entity_type | text | not null
audit_events | entity_id | text | not null
audit_events | details_json | jsonb | not null
audit_events | created_at | timestamp with time zone | not null
baseline_versions | id | uuid | not null
baseline_versions | agent_id | uuid | not null
baseline_versions | release_id | uuid | null
baseline_versions | environment | text | null
baseline_versions | status | text | not null
baseline_versions | source_time_start | timestamp with time zone | not null
baseline_versions | source_time_end | timestamp with time zone | not null
baseline_versions | minimum_runs | integer | not null
baseline_versions | rare_threshold_numerator | bigint | not null
baseline_versions | rare_threshold_denominator | bigint | not null
baseline_versions | baseline_identifier | text | not null
baseline_versions | selection_hash | text | not null
baseline_versions | selection_json | jsonb | not null
baseline_versions | normaliser_version | text | not null
baseline_versions | normaliser_config_hash | text | not null
baseline_versions | counts_json | jsonb | not null
baseline_versions | retrieval_json | jsonb | not null
baseline_versions | excluded_json | jsonb | not null
baseline_versions | disclosures_json | jsonb | not null
baseline_versions | job_id | uuid | null
baseline_versions | approved_at | timestamp with time zone | null
baseline_versions | created_at | timestamp with time zone | not null
baseline_versions | updated_at | timestamp with time zone | not null
contract_rules | id | uuid | not null
contract_rules | contract_id | uuid | not null
contract_rules | rule_key | text | not null
contract_rules | rule_type | text | not null
contract_rules | severity | text | not null
contract_rules | zero_tolerance | boolean | not null
contract_rules | rule_json | jsonb | not null
contract_rules | evidence_basis_json | jsonb | null
contract_rules | created_at | timestamp with time zone | not null
contracts | id | uuid | not null
contracts | agent_id | uuid | not null
contracts | baseline_version_id | uuid | null
contracts | name | text | not null
contracts | contract_key | text | not null
contracts | semantic_version | text | not null
contracts | schema_version | text | not null
contracts | environment | text | not null
contracts | status | text | not null
contracts | source | text | not null
contracts | yaml_text | text | not null
contracts | canonical_json | jsonb | not null
contracts | content_hash | text | not null
contracts | validation_errors_json | jsonb | not null
contracts | job_id | uuid | null
contracts | approved_at | timestamp with time zone | null
contracts | activated_at | timestamp with time zone | null
contracts | superseded_at | timestamp with time zone | null
contracts | superseded_by_contract_id | uuid | null
contracts | created_at | timestamp with time zone | not null
contracts | updated_at | timestamp with time zone | not null
evaluations | id | uuid | not null
evaluations | agent_id | uuid | not null
evaluations | contract_id | uuid | not null
evaluations | release_id | uuid | null
evaluations | scope | text | not null
evaluations | status | text | not null
evaluations | evaluator_version | text | not null
evaluations | normaliser_version | text | not null
evaluations | normaliser_config_hash | text | not null
evaluations | contract_content_hash | text | not null
evaluations | idempotency_key | text | not null
evaluations | window_start | timestamp with time zone | null
evaluations | window_end | timestamp with time zone | null
evaluations | started_at | timestamp with time zone | null
evaluations | completed_at | timestamp with time zone | null
evaluations | summary_json | jsonb | not null
evaluations | job_id | uuid | null
evaluations | created_at | timestamp with time zone | not null
evaluations | updated_at | timestamp with time zone | not null
jobs | id | uuid | not null
jobs | job_type | text | not null
jobs | entity_type | text | not null
jobs | entity_id | uuid | null
jobs | project_id | uuid | null
jobs | status | text | not null
jobs | attempt | integer | not null
jobs | max_attempts | integer | not null
jobs | idempotency_key | text | not null
jobs | input_hash | text | not null
jobs | input_json | jsonb | not null
jobs | result_json | jsonb | null
jobs | error_json | jsonb | null
jobs | progress_index | integer | not null
jobs | progress_stage | text | null
jobs | progress_json | jsonb | not null
jobs | lease_owner | text | null
jobs | lease_expires_at | timestamp with time zone | null
jobs | heartbeat_at | timestamp with time zone | null
jobs | available_at | timestamp with time zone | not null
jobs | cancel_requested | boolean | not null
jobs | started_at | timestamp with time zone | null
jobs | completed_at | timestamp with time zone | null
jobs | created_at | timestamp with time zone | not null
jobs | updated_at | timestamp with time zone | not null
projects | id | uuid | not null
projects | name | text | not null
projects | slug | text | not null
projects | description | text | not null
projects | signoz_connection_id | uuid | null
projects | default_environment | text | not null
projects | created_at | timestamp with time zone | not null
projects | updated_at | timestamp with time zone | not null
releases | id | uuid | not null
releases | agent_id | uuid | not null
releases | release_key | text | not null
releases | commit_sha | text | null
releases | image_digest | text | null
releases | environment | text | not null
releases | first_observed_at | timestamp with time zone | null
releases | last_observed_at | timestamp with time zone | null
releases | metadata_json | jsonb | not null
releases | created_at | timestamp with time zone | not null
releases | updated_at | timestamp with time zone | not null
route_families | id | uuid | not null
route_families | baseline_version_id | uuid | not null
route_families | family_identifier | text | not null
route_families | fingerprint | text | not null
route_families | canonical_graph_json | jsonb | not null
route_families | occurrence_count | integer | not null
route_families | occurrence_numerator | bigint | not null
route_families | occurrence_denominator | bigint | not null
route_families | occurrence_percent | numeric | not null
route_families | rare | boolean | not null
route_families | status | text | not null
route_families | representative_trace_ids_json | jsonb | not null
route_families | statistics_json | jsonb | not null
route_families | normaliser_version | text | not null
route_families | normaliser_config_hash | text | not null
route_families | decided_at | timestamp with time zone | null
route_families | created_at | timestamp with time zone | not null
route_families | updated_at | timestamp with time zone | not null
run_evaluations | id | uuid | not null
run_evaluations | evaluation_id | uuid | not null
run_evaluations | trace_run_id | uuid | not null
run_evaluations | status | text | not null
run_evaluations | nearest_route_family_id | uuid | null
run_evaluations | similarity_numerator | bigint | not null
run_evaluations | similarity_denominator | bigint | not null
run_evaluations | similarity_score | numeric | not null
run_evaluations | route_fingerprint | text | not null
run_evaluations | route_approved | boolean | not null
run_evaluations | evaluation_hash | text | not null
run_evaluations | result_json | jsonb | not null
run_evaluations | created_at | timestamp with time zone | not null
signoz_artifacts | id | uuid | not null
signoz_artifacts | project_id | uuid | not null
signoz_artifacts | agent_id | uuid | null
signoz_artifacts | artifact_type | text | not null
signoz_artifacts | managed_name | text | not null
signoz_artifacts | signoz_resource_id | text | null
signoz_artifacts | signoz_web_url | text | null
signoz_artifacts | spec_hash | text | not null
signoz_artifacts | last_synced_at | timestamp with time zone | null
signoz_artifacts | last_verified_at | timestamp with time zone | null
signoz_artifacts | status | text | not null
signoz_artifacts | remote_snapshot_json | jsonb | not null
signoz_artifacts | created_at | timestamp with time zone | not null
signoz_artifacts | updated_at | timestamp with time zone | not null
signoz_connections | id | uuid | not null
signoz_connections | name | text | not null
signoz_connections | base_url | text | not null
signoz_connections | mcp_url | text | not null
signoz_connections | api_key_secret_reference | text | not null
signoz_connections | status | text | not null
signoz_connections | last_verified_at | timestamp with time zone | null
signoz_connections | capabilities_json | jsonb | not null
signoz_connections | created_at | timestamp with time zone | not null
signoz_connections | updated_at | timestamp with time zone | not null
trace_graphs | id | uuid | not null
trace_graphs | trace_run_id | uuid | not null
trace_graphs | normaliser_version | text | not null
trace_graphs | normaliser_config_hash | text | not null
trace_graphs | graph_schema_version | text | not null
trace_graphs | fingerprint | text | not null
trace_graphs | canonical_graph_json | jsonb | not null
trace_graphs | feature_set_json | jsonb | not null
trace_graphs | quality_warnings_json | jsonb | not null
trace_graphs | created_at | timestamp with time zone | not null
trace_runs | id | uuid | not null
trace_runs | agent_id | uuid | not null
trace_runs | release_id | uuid | null
trace_runs | trace_id | text | not null
trace_runs | run_id | text | null
trace_runs | signoz_web_url | text | null
trace_runs | root_span_id | text | null
trace_runs | started_at | timestamp with time zone | not null
trace_runs | completed_at | timestamp with time zone | null
trace_runs | duration_ms | integer | null
trace_runs | status | text | not null
trace_runs | quality_status | text | not null
trace_runs | raw_summary_json | jsonb | not null
trace_runs | created_at | timestamp with time zone | not null
violations | id | uuid | not null
violations | run_evaluation_id | uuid | not null
violations | violation_key | text | not null
violations | rule_key | text | not null
violations | rule_type | text | not null
violations | violation_type | text | not null
violations | severity | text | not null
violations | zero_tolerance | boolean | not null
violations | message | text | not null
violations | expected | text | not null
violations | observed | text | not null
violations | evidence_json | jsonb | not null
violations | signoz_web_url | text | null
violations | created_at | timestamp with time zone | not null
```

## Constraints

```text
agents | c | agents_agent_key_check | CHECK ((agent_key ~ '^[a-z0-9][a-z0-9._-]{0,63}$'::text))
agents | c | agents_environment_attribute_key_check | CHECK (((length(TRIM(BOTH FROM environment_attribute_key)) >= 1) AND (length(TRIM(BOTH FROM environment_attribute_key)) <= 120)))
agents | c | agents_name_check | CHECK (((length(TRIM(BOTH FROM name)) >= 1) AND (length(TRIM(BOTH FROM name)) <= 120)))
agents | c | agents_normaliser_config_id_check | CHECK (((length(normaliser_config_id) >= 1) AND (length(normaliser_config_id) <= 120)))
agents | c | agents_release_attribute_key_check | CHECK (((length(TRIM(BOTH FROM release_attribute_key)) >= 1) AND (length(TRIM(BOTH FROM release_attribute_key)) <= 120)))
agents | c | agents_root_matcher_is_object | CHECK ((jsonb_typeof(root_span_matcher_json) = 'object'::text))
agents | c | agents_service_matchers_is_array | CHECK ((jsonb_typeof(service_matchers_json) = 'array'::text))
agents | c | agents_workflow_name_matcher_check | CHECK (((length(workflow_name_matcher) >= 1) AND (length(workflow_name_matcher) <= 200)))
agents | f | agents_project_id_fkey | FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
agents | p | agents_pkey | PRIMARY KEY (id)
agents | u | agents_project_key_unique | UNIQUE (project_id, agent_key)
audit_events | c | audit_events_actor_type_check | CHECK ((actor_type = ANY (ARRAY['user'::text, 'system'::text, 'cli'::text, 'demo'::text])))
audit_events | f | audit_events_project_id_fkey | FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
audit_events | p | audit_events_pkey | PRIMARY KEY (id)
baseline_versions | c | baseline_versions_approval | CHECK (((status = 'approved'::text) = (approved_at IS NOT NULL)))
baseline_versions | c | baseline_versions_baseline_identifier_check | CHECK ((baseline_identifier ~ '^bl-[0-9a-f]{32}$'::text))
baseline_versions | c | baseline_versions_disclosures_json_check | CHECK ((jsonb_typeof(disclosures_json) = 'array'::text))
baseline_versions | c | baseline_versions_excluded_json_check | CHECK ((jsonb_typeof(excluded_json) = 'array'::text))
baseline_versions | c | baseline_versions_minimum_runs_check | CHECK ((minimum_runs > 0))
baseline_versions | c | baseline_versions_normaliser_config_hash_check | CHECK ((normaliser_config_hash ~ '^[0-9a-f]{64}$'::text))
baseline_versions | c | baseline_versions_rare_threshold_denominator_check | CHECK ((rare_threshold_denominator > 0))
baseline_versions | c | baseline_versions_rare_threshold_numerator_check | CHECK ((rare_threshold_numerator >= 0))
baseline_versions | c | baseline_versions_selection_hash_check | CHECK ((selection_hash ~ '^[0-9a-f]{64}$'::text))
baseline_versions | c | baseline_versions_status_check | CHECK ((status = ANY (ARRAY['dataset_truncated'::text, 'insufficient_runs'::text, 'pending_review'::text, 'approved'::text])))
baseline_versions | c | baseline_versions_window_order | CHECK ((source_time_end > source_time_start))
baseline_versions | f | baseline_versions_agent_id_fkey | FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
baseline_versions | f | baseline_versions_job_id_fkey | FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE SET NULL
baseline_versions | f | baseline_versions_release_id_fkey | FOREIGN KEY (release_id) REFERENCES releases(id) ON DELETE SET NULL
baseline_versions | p | baseline_versions_pkey | PRIMARY KEY (id)
baseline_versions | u | baseline_versions_identifier_unique | UNIQUE (baseline_identifier)
baseline_versions | u | baseline_versions_selection_unique | UNIQUE (agent_id, selection_hash)
contract_rules | c | contract_rules_rule_key_check | CHECK (((length(rule_key) >= 1) AND (length(rule_key) <= 128)))
contract_rules | c | contract_rules_rule_type_check | CHECK ((rule_type = ANY (ARRAY['required_span'::text, 'required_ancestry'::text, 'required_edge'::text, 'forbidden_span'::text, 'forbidden_path'::text, 'cardinality'::text, 'allowed_values'::text, 'attribute_constraint'::text, 'retry_budget'::text, 'approved_routes'::text, 'numeric_budget'::text])))
contract_rules | c | contract_rules_severity_check | CHECK ((severity = ANY (ARRAY['low'::text, 'medium'::text, 'high'::text, 'critical'::text])))
contract_rules | f | contract_rules_contract_id_fkey | FOREIGN KEY (contract_id) REFERENCES contracts(id) ON DELETE CASCADE
contract_rules | p | contract_rules_pkey | PRIMARY KEY (id)
contract_rules | u | contract_rules_key_unique | UNIQUE (contract_id, rule_key)
contracts | c | contracts_activated_timestamp | CHECK (((status = ANY (ARRAY['draft'::text, 'invalid'::text, 'approved'::text])) OR (activated_at IS NOT NULL)))
contracts | c | contracts_approved_timestamp | CHECK (((status = ANY (ARRAY['draft'::text, 'invalid'::text])) OR (approved_at IS NOT NULL)))
contracts | c | contracts_content_hash_check | CHECK ((content_hash ~ '^[0-9a-f]{64}$'::text))
contracts | c | contracts_contract_key_check | CHECK ((contract_key ~ '^[a-z0-9][a-z0-9._-]{0,127}$'::text))
contracts | c | contracts_environment_check | CHECK (((length(TRIM(BOTH FROM environment)) >= 1) AND (length(TRIM(BOTH FROM environment)) <= 120)))
contracts | c | contracts_invalid_has_errors | CHECK (((status <> 'invalid'::text) OR (jsonb_array_length(validation_errors_json) > 0)))
contracts | c | contracts_name_check | CHECK (((length(TRIM(BOTH FROM name)) >= 1) AND (length(TRIM(BOTH FROM name)) <= 200)))
contracts | c | contracts_not_self_superseding | CHECK ((superseded_by_contract_id <> id))
contracts | c | contracts_schema_version_check | CHECK (((length(schema_version) >= 1) AND (length(schema_version) <= 60)))
contracts | c | contracts_semantic_version_check | CHECK ((semantic_version ~ '^[0-9]+\.[0-9]+\.[0-9]+$'::text))
contracts | c | contracts_source_check | CHECK ((source = ANY (ARRAY['authored'::text, 'mined'::text])))
contracts | c | contracts_status_check | CHECK ((status = ANY (ARRAY['draft'::text, 'approved'::text, 'active'::text, 'superseded'::text, 'invalid'::text])))
contracts | c | contracts_superseded_timestamp | CHECK (((status = 'superseded'::text) = (superseded_at IS NOT NULL)))
contracts | c | contracts_validation_errors_json_check | CHECK ((jsonb_typeof(validation_errors_json) = 'array'::text))
contracts | f | contracts_agent_id_fkey | FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
contracts | f | contracts_baseline_version_id_fkey | FOREIGN KEY (baseline_version_id) REFERENCES baseline_versions(id) ON DELETE SET NULL
contracts | f | contracts_job_id_fkey | FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE SET NULL
contracts | f | contracts_superseded_by_contract_id_fkey | FOREIGN KEY (superseded_by_contract_id) REFERENCES contracts(id) ON DELETE SET NULL
contracts | p | contracts_pkey | PRIMARY KEY (id)
contracts | u | contracts_version_unique | UNIQUE (agent_id, contract_key, semantic_version, environment)
evaluations | c | evaluations_contract_content_hash_check | CHECK ((contract_content_hash ~ '^[0-9a-f]{64}$'::text))
evaluations | c | evaluations_evaluator_version_check | CHECK (((length(evaluator_version) >= 1) AND (length(evaluator_version) <= 40)))
evaluations | c | evaluations_idempotency_key_check | CHECK ((idempotency_key ~ '^[0-9a-f]{64}$'::text))
evaluations | c | evaluations_normaliser_config_hash_check | CHECK ((normaliser_config_hash ~ '^[0-9a-f]{64}$'::text))
evaluations | c | evaluations_normaliser_version_check | CHECK (((length(normaliser_version) >= 1) AND (length(normaliser_version) <= 40)))
evaluations | c | evaluations_scope_check | CHECK ((scope = ANY (ARRAY['run'::text, 'release'::text])))
evaluations | c | evaluations_status_check | CHECK ((status = ANY (ARRAY['queued'::text, 'running'::text, 'pass'::text, 'fail'::text, 'error'::text, 'insufficient_data'::text])))
evaluations | c | evaluations_terminal_completed | CHECK (((status = ANY (ARRAY['pass'::text, 'fail'::text, 'error'::text, 'insufficient_data'::text])) = (completed_at IS NOT NULL)))
evaluations | c | evaluations_window_order | CHECK (((window_start IS NULL) OR (window_end IS NULL) OR (window_end > window_start)))
evaluations | f | evaluations_agent_id_fkey | FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
evaluations | f | evaluations_contract_id_fkey | FOREIGN KEY (contract_id) REFERENCES contracts(id) ON DELETE CASCADE
evaluations | f | evaluations_job_id_fkey | FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE SET NULL
evaluations | f | evaluations_release_id_fkey | FOREIGN KEY (release_id) REFERENCES releases(id) ON DELETE SET NULL
evaluations | p | evaluations_pkey | PRIMARY KEY (id)
evaluations | u | evaluations_idempotency_unique | UNIQUE (contract_id, scope, idempotency_key)
jobs | c | jobs_attempt_bounded | CHECK ((attempt <= max_attempts))
jobs | c | jobs_attempt_check | CHECK ((attempt >= 0))
jobs | c | jobs_entity_type_check | CHECK ((entity_type = ANY (ARRAY['agent'::text, 'baseline_version'::text, 'contract'::text, 'release'::text, 'project'::text])))
jobs | c | jobs_failed_has_error | CHECK (((status <> 'failed'::text) OR (error_json IS NOT NULL)))
jobs | c | jobs_idempotency_key_check | CHECK (((length(idempotency_key) >= 1) AND (length(idempotency_key) <= 200)))
jobs | c | jobs_input_hash_check | CHECK ((input_hash ~ '^[0-9a-f]{64}$'::text))
jobs | c | jobs_job_type_check | CHECK ((job_type = ANY (ARRAY['baseline_mining'::text, 'contract_proposal'::text, 'evaluation'::text, 'demo_run'::text])))
jobs | c | jobs_lease_owner_check | CHECK (((lease_owner IS NULL) OR ((length(lease_owner) >= 1) AND (length(lease_owner) <= 200))))
jobs | c | jobs_max_attempts_check | CHECK (((max_attempts >= 1) AND (max_attempts <= 20)))
jobs | c | jobs_progress_index_check | CHECK ((progress_index >= 0))
jobs | c | jobs_progress_json_check | CHECK ((jsonb_typeof(progress_json) = 'array'::text))
jobs | c | jobs_running_holds_lease | CHECK (((status <> 'running'::text) OR ((lease_owner IS NOT NULL) AND (lease_expires_at IS NOT NULL))))
jobs | c | jobs_status_check | CHECK ((status = ANY (ARRAY['queued'::text, 'running'::text, 'succeeded'::text, 'failed'::text, 'cancelled'::text])))
jobs | c | jobs_succeeded_has_result | CHECK (((status <> 'succeeded'::text) OR (result_json IS NOT NULL)))
jobs | c | jobs_terminal_completed | CHECK (((status = ANY (ARRAY['succeeded'::text, 'failed'::text, 'cancelled'::text])) = (completed_at IS NOT NULL)))
jobs | f | jobs_project_id_fkey | FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
jobs | p | jobs_pkey | PRIMARY KEY (id)
jobs | u | jobs_idempotency_unique | UNIQUE (job_type, idempotency_key)
projects | c | projects_name_check | CHECK (((length(TRIM(BOTH FROM name)) >= 1) AND (length(TRIM(BOTH FROM name)) <= 120)))
projects | c | projects_slug_check | CHECK ((slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'::text))
projects | f | projects_signoz_connection_id_fkey | FOREIGN KEY (signoz_connection_id) REFERENCES signoz_connections(id) ON DELETE SET NULL
projects | p | projects_pkey | PRIMARY KEY (id)
projects | u | projects_slug_unique | UNIQUE (slug)
releases | c | releases_commit_sha_check | CHECK (((commit_sha IS NULL) OR (commit_sha ~ '^[0-9a-f]{7,64}$'::text)))
releases | c | releases_environment_check | CHECK (((length(TRIM(BOTH FROM environment)) >= 1) AND (length(TRIM(BOTH FROM environment)) <= 120)))
releases | c | releases_image_digest_check | CHECK (((image_digest IS NULL) OR ((length(image_digest) >= 1) AND (length(image_digest) <= 200))))
releases | c | releases_observation_order | CHECK (((first_observed_at IS NULL) OR (last_observed_at IS NULL) OR (last_observed_at >= first_observed_at)))
releases | c | releases_release_key_check | CHECK (((length(TRIM(BOTH FROM release_key)) >= 1) AND (length(TRIM(BOTH FROM release_key)) <= 200)))
releases | f | releases_agent_id_fkey | FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
releases | p | releases_pkey | PRIMARY KEY (id)
releases | u | releases_agent_key_unique | UNIQUE (agent_id, release_key, environment)
route_families | c | route_families_decision_timestamp | CHECK (((status = 'pending'::text) = (decided_at IS NULL)))
route_families | c | route_families_family_identifier_check | CHECK ((family_identifier ~ '^rf-[0-9a-f]{32}$'::text))
route_families | c | route_families_fingerprint_check | CHECK ((fingerprint ~ '^[0-9a-f]{64}$'::text))
route_families | c | route_families_normaliser_config_hash_check | CHECK ((normaliser_config_hash ~ '^[0-9a-f]{64}$'::text))
route_families | c | route_families_occurrence_count_check | CHECK ((occurrence_count >= 0))
route_families | c | route_families_occurrence_denominator_check | CHECK ((occurrence_denominator > 0))
route_families | c | route_families_occurrence_numerator_check | CHECK ((occurrence_numerator >= 0))
route_families | c | route_families_occurrence_percent_check | CHECK (((occurrence_percent >= (0)::numeric) AND (occurrence_percent <= (1)::numeric)))
route_families | c | route_families_percent_matches_counts | CHECK ((occurrence_percent = (trunc((((occurrence_numerator)::numeric * (1000000)::numeric) / (occurrence_denominator)::numeric)) / (1000000)::numeric)))
route_families | c | route_families_representative_trace_ids_json_check | CHECK ((jsonb_typeof(representative_trace_ids_json) = 'array'::text))
route_families | c | route_families_status_check | CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text, 'optional'::text, 'excluded_fixture_error'::text])))
route_families | f | route_families_baseline_version_id_fkey | FOREIGN KEY (baseline_version_id) REFERENCES baseline_versions(id) ON DELETE CASCADE
route_families | p | route_families_pkey | PRIMARY KEY (id)
route_families | u | route_families_baseline_fingerprint_unique | UNIQUE (baseline_version_id, fingerprint)
route_families | u | route_families_identifier_unique | UNIQUE (family_identifier)
run_evaluations | c | run_evaluations_evaluation_hash_check | CHECK ((evaluation_hash ~ '^[0-9a-f]{64}$'::text))
run_evaluations | c | run_evaluations_route_fingerprint_check | CHECK ((route_fingerprint ~ '^[0-9a-f]{64}$'::text))
run_evaluations | c | run_evaluations_similarity_denominator_check | CHECK ((similarity_denominator > 0))
run_evaluations | c | run_evaluations_similarity_matches_counts | CHECK ((similarity_score = (trunc((((similarity_numerator)::numeric * (1000000)::numeric) / (similarity_denominator)::numeric)) / (1000000)::numeric)))
run_evaluations | c | run_evaluations_similarity_numerator_check | CHECK ((similarity_numerator >= 0))
run_evaluations | c | run_evaluations_similarity_score_check | CHECK (((similarity_score >= (0)::numeric) AND (similarity_score <= (1)::numeric)))
run_evaluations | c | run_evaluations_status_check | CHECK ((status = ANY (ARRAY['pass'::text, 'fail'::text, 'error'::text, 'insufficient_data'::text])))
run_evaluations | f | run_evaluations_evaluation_id_fkey | FOREIGN KEY (evaluation_id) REFERENCES evaluations(id) ON DELETE CASCADE
run_evaluations | f | run_evaluations_nearest_route_family_id_fkey | FOREIGN KEY (nearest_route_family_id) REFERENCES route_families(id) ON DELETE SET NULL
run_evaluations | f | run_evaluations_trace_run_id_fkey | FOREIGN KEY (trace_run_id) REFERENCES trace_runs(id) ON DELETE CASCADE
run_evaluations | p | run_evaluations_pkey | PRIMARY KEY (id)
run_evaluations | u | run_evaluations_unique | UNIQUE (evaluation_id, trace_run_id)
signoz_artifacts | c | signoz_artifacts_artifact_type_check | CHECK ((artifact_type = ANY (ARRAY['saved_view'::text, 'dashboard'::text, 'alert'::text, 'notification_channel'::text])))
signoz_artifacts | c | signoz_artifacts_managed_name_check | CHECK (((length(managed_name) >= 1) AND (length(managed_name) <= 200)))
signoz_artifacts | c | signoz_artifacts_signoz_web_url_check | CHECK (((signoz_web_url IS NULL) OR (signoz_web_url ~ '^https?://'::text)))
signoz_artifacts | c | signoz_artifacts_spec_hash_check | CHECK ((spec_hash ~ '^[0-9a-f]{64}$'::text))
signoz_artifacts | c | signoz_artifacts_status_check | CHECK ((status = ANY (ARRAY['pending'::text, 'synced'::text, 'drifted'::text, 'failed'::text, 'deleted'::text])))
signoz_artifacts | f | signoz_artifacts_agent_id_fkey | FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
signoz_artifacts | f | signoz_artifacts_project_id_fkey | FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
signoz_artifacts | p | signoz_artifacts_pkey | PRIMARY KEY (id)
signoz_artifacts | u | signoz_artifacts_managed_name_unique | UNIQUE (project_id, managed_name)
signoz_connections | c | signoz_connections_status_check | CHECK ((status = ANY (ARRAY['unverified'::text, 'connected'::text, 'degraded'::text, 'failed'::text])))
signoz_connections | p | signoz_connections_pkey | PRIMARY KEY (id)
signoz_connections | u | signoz_connections_name_unique | UNIQUE (name)
trace_graphs | c | trace_graphs_fingerprint_check | CHECK ((fingerprint ~ '^[0-9a-f]{64}$'::text))
trace_graphs | c | trace_graphs_graph_schema_version_check | CHECK (((length(graph_schema_version) >= 1) AND (length(graph_schema_version) <= 40)))
trace_graphs | c | trace_graphs_normaliser_config_hash_check | CHECK ((normaliser_config_hash ~ '^[0-9a-f]{64}$'::text))
trace_graphs | c | trace_graphs_normaliser_version_check | CHECK (((length(normaliser_version) >= 1) AND (length(normaliser_version) <= 40)))
trace_graphs | c | trace_graphs_quality_warnings_json_check | CHECK ((jsonb_typeof(quality_warnings_json) = 'array'::text))
trace_graphs | f | trace_graphs_trace_run_id_fkey | FOREIGN KEY (trace_run_id) REFERENCES trace_runs(id) ON DELETE CASCADE
trace_graphs | p | trace_graphs_pkey | PRIMARY KEY (id)
trace_graphs | u | trace_graphs_run_normaliser_unique | UNIQUE (trace_run_id, normaliser_version)
trace_runs | c | trace_runs_duration_ms_check | CHECK (((duration_ms IS NULL) OR (duration_ms >= 0)))
trace_runs | c | trace_runs_quality_status_check | CHECK ((quality_status = ANY (ARRAY['complete'::text, 'incomplete'::text, 'inconsistent'::text, 'too_large'::text])))
trace_runs | c | trace_runs_root_span_id_check | CHECK (((root_span_id IS NULL) OR (root_span_id ~ '^[0-9a-z_]{1,64}$'::text)))
trace_runs | c | trace_runs_run_id_check | CHECK (((run_id IS NULL) OR ((length(run_id) >= 1) AND (length(run_id) <= 200))))
trace_runs | c | trace_runs_signoz_web_url_check | CHECK (((signoz_web_url IS NULL) OR (signoz_web_url ~ '^https?://'::text)))
trace_runs | c | trace_runs_status_check | CHECK ((status = ANY (ARRAY['ok'::text, 'error'::text, 'unknown'::text])))
trace_runs | c | trace_runs_trace_id_check | CHECK ((trace_id ~ '^[0-9a-f]{8,64}$'::text))
trace_runs | f | trace_runs_agent_id_fkey | FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
trace_runs | f | trace_runs_release_id_fkey | FOREIGN KEY (release_id) REFERENCES releases(id) ON DELETE SET NULL
trace_runs | p | trace_runs_pkey | PRIMARY KEY (id)
trace_runs | u | trace_runs_agent_trace_unique | UNIQUE (agent_id, trace_id)
violations | c | violations_message_check | CHECK (((length(message) >= 1) AND (length(message) <= 2000)))
violations | c | violations_rule_key_check | CHECK (((length(rule_key) >= 1) AND (length(rule_key) <= 128)))
violations | c | violations_rule_type_check | CHECK ((rule_type = ANY (ARRAY['required_span'::text, 'required_ancestry'::text, 'required_edge'::text, 'forbidden_span'::text, 'forbidden_path'::text, 'cardinality'::text, 'allowed_values'::text, 'attribute_constraint'::text, 'retry_budget'::text, 'approved_routes'::text, 'numeric_budget'::text])))
violations | c | violations_severity_check | CHECK ((severity = ANY (ARRAY['low'::text, 'medium'::text, 'high'::text, 'critical'::text])))
violations | c | violations_signoz_web_url_check | CHECK (((signoz_web_url IS NULL) OR (signoz_web_url ~ '^https?://'::text)))
violations | c | violations_violation_key_check | CHECK (((length(violation_key) >= 1) AND (length(violation_key) <= 200)))
violations | c | violations_violation_type_check | CHECK ((violation_type = ANY (ARRAY['REQUIRED_SPAN_MISSING'::text, 'REQUIRED_SPAN_TOO_MANY'::text, 'REQUIRED_ANCESTRY_MISSING'::text, 'REQUIRED_EDGE_MISSING'::text, 'FORBIDDEN_SPAN_PRESENT'::text, 'FORBIDDEN_PATH_PRESENT'::text, 'CARDINALITY_BELOW_MIN'::text, 'CARDINALITY_ABOVE_MAX'::text, 'DISALLOWED_VALUE'::text, 'ATTRIBUTE_CONSTRAINT_FAILED'::text, 'RETRY_BUDGET_PER_TOOL_EXCEEDED'::text, 'RETRY_BUDGET_RUN_TOTAL_EXCEEDED'::text, 'RETRY_BUDGET_SIDE_EFFECT_EXCEEDED'::text, 'ROUTE_NOT_APPROVED'::text, 'ROUTE_DRIFTED'::text, 'NUMERIC_BUDGET_EXCEEDED'::text])))
violations | f | violations_run_evaluation_id_fkey | FOREIGN KEY (run_evaluation_id) REFERENCES run_evaluations(id) ON DELETE CASCADE
violations | p | violations_pkey | PRIMARY KEY (id)
violations | u | violations_key_unique | UNIQUE (run_evaluation_id, violation_key)
```

## Indexes

```text
CREATE UNIQUE INDEX agents_pkey ON public.agents USING btree (id)
CREATE INDEX agents_project_idx ON public.agents USING btree (project_id, agent_key)
CREATE UNIQUE INDEX agents_project_key_unique ON public.agents USING btree (project_id, agent_key)
CREATE INDEX audit_events_entity_idx ON public.audit_events USING btree (entity_type, entity_id, created_at DESC)
CREATE UNIQUE INDEX audit_events_pkey ON public.audit_events USING btree (id)
CREATE INDEX audit_events_project_created_idx ON public.audit_events USING btree (project_id, created_at DESC)
CREATE INDEX baseline_versions_agent_idx ON public.baseline_versions USING btree (agent_id, created_at DESC)
CREATE UNIQUE INDEX baseline_versions_identifier_unique ON public.baseline_versions USING btree (baseline_identifier)
CREATE UNIQUE INDEX baseline_versions_pkey ON public.baseline_versions USING btree (id)
CREATE UNIQUE INDEX baseline_versions_selection_unique ON public.baseline_versions USING btree (agent_id, selection_hash)
CREATE INDEX contract_rules_contract_idx ON public.contract_rules USING btree (contract_id, rule_key)
CREATE UNIQUE INDEX contract_rules_key_unique ON public.contract_rules USING btree (contract_id, rule_key)
CREATE UNIQUE INDEX contract_rules_pkey ON public.contract_rules USING btree (id)
CREATE INDEX contracts_agent_idx ON public.contracts USING btree (agent_id, created_at DESC)
CREATE INDEX contracts_hash_idx ON public.contracts USING btree (content_hash)
CREATE UNIQUE INDEX contracts_one_active_per_environment ON public.contracts USING btree (agent_id, environment) WHERE (status = 'active'::text)
CREATE UNIQUE INDEX contracts_pkey ON public.contracts USING btree (id)
CREATE UNIQUE INDEX contracts_version_unique ON public.contracts USING btree (agent_id, contract_key, semantic_version, environment)
CREATE INDEX evaluations_agent_idx ON public.evaluations USING btree (agent_id, created_at DESC)
CREATE INDEX evaluations_contract_idx ON public.evaluations USING btree (contract_id, created_at DESC)
CREATE UNIQUE INDEX evaluations_idempotency_unique ON public.evaluations USING btree (contract_id, scope, idempotency_key)
CREATE UNIQUE INDEX evaluations_pkey ON public.evaluations USING btree (id)
CREATE INDEX evaluations_release_idx ON public.evaluations USING btree (release_id, created_at DESC)
CREATE INDEX jobs_claimable_idx ON public.jobs USING btree (job_type, available_at, created_at) WHERE (status = 'queued'::text)
CREATE INDEX jobs_entity_idx ON public.jobs USING btree (entity_type, entity_id, created_at DESC)
CREATE UNIQUE INDEX jobs_idempotency_unique ON public.jobs USING btree (job_type, idempotency_key)
CREATE INDEX jobs_lease_idx ON public.jobs USING btree (lease_expires_at) WHERE (status = 'running'::text)
CREATE UNIQUE INDEX jobs_pkey ON public.jobs USING btree (id)
CREATE INDEX jobs_project_idx ON public.jobs USING btree (project_id, created_at DESC)
CREATE UNIQUE INDEX projects_pkey ON public.projects USING btree (id)
CREATE UNIQUE INDEX projects_slug_unique ON public.projects USING btree (slug)
CREATE INDEX releases_agent_idx ON public.releases USING btree (agent_id, last_observed_at DESC NULLS LAST)
CREATE UNIQUE INDEX releases_agent_key_unique ON public.releases USING btree (agent_id, release_key, environment)
CREATE UNIQUE INDEX releases_pkey ON public.releases USING btree (id)
CREATE UNIQUE INDEX route_families_baseline_fingerprint_unique ON public.route_families USING btree (baseline_version_id, fingerprint)
CREATE INDEX route_families_baseline_idx ON public.route_families USING btree (baseline_version_id, fingerprint)
CREATE INDEX route_families_fingerprint_idx ON public.route_families USING btree (fingerprint)
CREATE UNIQUE INDEX route_families_identifier_unique ON public.route_families USING btree (family_identifier)
CREATE UNIQUE INDEX route_families_pkey ON public.route_families USING btree (id)
CREATE INDEX run_evaluations_evaluation_idx ON public.run_evaluations USING btree (evaluation_id, created_at)
CREATE UNIQUE INDEX run_evaluations_pkey ON public.run_evaluations USING btree (id)
CREATE INDEX run_evaluations_trace_idx ON public.run_evaluations USING btree (trace_run_id)
CREATE UNIQUE INDEX run_evaluations_unique ON public.run_evaluations USING btree (evaluation_id, trace_run_id)
CREATE UNIQUE INDEX signoz_artifacts_managed_name_unique ON public.signoz_artifacts USING btree (project_id, managed_name)
CREATE UNIQUE INDEX signoz_artifacts_pkey ON public.signoz_artifacts USING btree (id)
CREATE INDEX signoz_artifacts_project_idx ON public.signoz_artifacts USING btree (project_id, artifact_type)
CREATE UNIQUE INDEX signoz_connections_name_unique ON public.signoz_connections USING btree (name)
CREATE UNIQUE INDEX signoz_connections_pkey ON public.signoz_connections USING btree (id)
CREATE INDEX trace_graphs_fingerprint_idx ON public.trace_graphs USING btree (fingerprint)
CREATE UNIQUE INDEX trace_graphs_pkey ON public.trace_graphs USING btree (id)
CREATE UNIQUE INDEX trace_graphs_run_normaliser_unique ON public.trace_graphs USING btree (trace_run_id, normaliser_version)
CREATE INDEX trace_runs_agent_started_idx ON public.trace_runs USING btree (agent_id, started_at DESC)
CREATE UNIQUE INDEX trace_runs_agent_trace_unique ON public.trace_runs USING btree (agent_id, trace_id)
CREATE UNIQUE INDEX trace_runs_pkey ON public.trace_runs USING btree (id)
CREATE INDEX trace_runs_release_idx ON public.trace_runs USING btree (release_id, started_at DESC)
CREATE UNIQUE INDEX violations_key_unique ON public.violations USING btree (run_evaluation_id, violation_key)
CREATE UNIQUE INDEX violations_pkey ON public.violations USING btree (id)
CREATE INDEX violations_rule_idx ON public.violations USING btree (rule_key, created_at DESC)
CREATE INDEX violations_run_evaluation_idx ON public.violations USING btree (run_evaluation_id)
CREATE INDEX violations_severity_idx ON public.violations USING btree (severity, created_at DESC)
```
