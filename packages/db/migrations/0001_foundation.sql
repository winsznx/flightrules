-- migrate:up

create extension if not exists "pgcrypto";

-- Sortable, time-ordered identifiers (PRD section 14: "UUIDv7 or another sortable format").
-- Postgres 16 has no native uuidv7(), so it is implemented here: 48-bit big-endian Unix
-- milliseconds, version 7 nibble, variant bits, and 74 bits of randomness.
create or replace function flightrules_uuid_v7() returns uuid
language plpgsql
volatile
as $$
declare
  unix_ms bigint := (extract(epoch from clock_timestamp()) * 1000)::bigint;
  bytes bytea := gen_random_bytes(16);
begin
  bytes := set_byte(bytes, 0, ((unix_ms >> 40) & 255)::int);
  bytes := set_byte(bytes, 1, ((unix_ms >> 32) & 255)::int);
  bytes := set_byte(bytes, 2, ((unix_ms >> 24) & 255)::int);
  bytes := set_byte(bytes, 3, ((unix_ms >> 16) & 255)::int);
  bytes := set_byte(bytes, 4, ((unix_ms >> 8) & 255)::int);
  bytes := set_byte(bytes, 5, (unix_ms & 255)::int);
  bytes := set_byte(bytes, 6, ((get_byte(bytes, 6) & 15) | 112));
  bytes := set_byte(bytes, 8, ((get_byte(bytes, 8) & 63) | 128));
  return encode(bytes, 'hex')::uuid;
end;
$$;

create or replace function flightrules_touch_updated_at() returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create table signoz_connections (
  id uuid primary key default flightrules_uuid_v7(),
  name text not null,
  base_url text not null,
  mcp_url text not null,
  api_key_secret_reference text not null,
  status text not null default 'unverified'
    check (status in ('unverified', 'connected', 'degraded', 'failed')),
  last_verified_at timestamptz,
  capabilities_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint signoz_connections_name_unique unique (name)
);

create trigger signoz_connections_touch
  before update on signoz_connections
  for each row execute function flightrules_touch_updated_at();

create table projects (
  id uuid primary key default flightrules_uuid_v7(),
  name text not null check (length(trim(name)) between 1 and 120),
  slug text not null check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  description text not null default '',
  signoz_connection_id uuid references signoz_connections (id) on delete set null,
  default_environment text not null default 'production',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint projects_slug_unique unique (slug)
);

create trigger projects_touch
  before update on projects
  for each row execute function flightrules_touch_updated_at();

create table audit_events (
  id uuid primary key default flightrules_uuid_v7(),
  project_id uuid references projects (id) on delete cascade,
  actor_type text not null check (actor_type in ('user', 'system', 'cli', 'demo')),
  actor_id text not null default 'local',
  event_type text not null,
  entity_type text not null,
  entity_id text not null,
  details_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index audit_events_project_created_idx
  on audit_events (project_id, created_at desc);
create index audit_events_entity_idx
  on audit_events (entity_type, entity_id, created_at desc);

-- migrate:down

drop table if exists audit_events;
drop trigger if exists projects_touch on projects;
drop table if exists projects;
drop trigger if exists signoz_connections_touch on signoz_connections;
drop table if exists signoz_connections;
drop function if exists flightrules_touch_updated_at();
drop function if exists flightrules_uuid_v7();
