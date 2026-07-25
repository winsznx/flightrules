-- migrate:up

-- Phase 10: what the SigNoz artefact compiler needs beyond PRD section 14.14's minimum shape.
--
-- Migrations 0001, 0002 and 0003 are never edited; this file is forward-only. No table is added:
-- ADR-0008 fixes the P0 table set at sixteen, and every column here belongs to a row that already
-- exists. `signoz_artifacts` is still the artefact register; it now records *how* the last sync
-- reached its verdict, which is what makes a mismatch reviewable after the job that found it has
-- gone.

-- ---------------------------------------------------------------------------
-- A sync is a job like any other
-- ---------------------------------------------------------------------------

alter table jobs drop constraint jobs_job_type_check;
alter table jobs add constraint jobs_job_type_check check (
  job_type in ('baseline_mining', 'contract_proposal', 'evaluation', 'demo_run', 'signoz_sync')
);

-- ---------------------------------------------------------------------------
-- 14.14 signoz_artifacts, extended
-- ---------------------------------------------------------------------------

-- A resource that exists in SigNoz under a managed name but is not ours is neither synced nor
-- drifted nor failed. Overwriting it would destroy someone else's work, so it gets its own state.
alter table signoz_artifacts drop constraint signoz_artifacts_status_check;
alter table signoz_artifacts add constraint signoz_artifacts_status_check check (
  status in ('pending', 'synced', 'drifted', 'failed', 'deleted', 'conflict')
);

alter table signoz_artifacts
  -- The contract whose activation produced this artefact. `set null` rather than `cascade`: a
  -- deleted contract must not silently erase the record of a resource still live in SigNoz.
  add column contract_id uuid references contracts (id) on delete set null,
  add column last_operation text check (
    last_operation is null or last_operation in (
      'created', 'updated', 'unchanged', 'conflict', 'failed', 'stale'
    )
  ),
  add column sync_attempt integer not null default 0 check (sync_attempt >= 0),
  -- The field-by-field comparison of desired against actual. Redacted before it is written.
  add column verification_json jsonb not null default '{}'::jsonb,
  add column last_error_json jsonb;

create index signoz_artifacts_contract_idx on signoz_artifacts (contract_id)
  where contract_id is not null;

-- migrate:down

drop index if exists signoz_artifacts_contract_idx;

alter table signoz_artifacts
  drop column if exists last_error_json,
  drop column if exists verification_json,
  drop column if exists sync_attempt,
  drop column if exists last_operation,
  drop column if exists contract_id;

alter table signoz_artifacts drop constraint signoz_artifacts_status_check;
alter table signoz_artifacts add constraint signoz_artifacts_status_check check (
  status in ('pending', 'synced', 'drifted', 'failed', 'deleted')
);

alter table jobs drop constraint jobs_job_type_check;
alter table jobs add constraint jobs_job_type_check check (
  job_type in ('baseline_mining', 'contract_proposal', 'evaluation', 'demo_run')
);
