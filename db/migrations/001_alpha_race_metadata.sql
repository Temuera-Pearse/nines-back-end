create table if not exists races (
  race_id text primary key,
  seed text not null,
  lifecycle_status text not null,
  scheduled_start_time timestamptz null,
  actual_start_time timestamptz null,
  actual_end_time timestamptz null,
  checksum text null,
  winner_id text null,
  finish_order jsonb not null default '[]'::jsonb,
  finish_times_ms jsonb not null default '{}'::jsonb,
  config jsonb not null,
  has_tick_stream boolean not null default false,
  has_precomputed_paths boolean not null default false,
  events_count integer not null default 0,
  persistence_status text not null default 'pending',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint races_lifecycle_status_chk
    check (lifecycle_status in ('seeded', 'running', 'finished', 'results_showing', 'archived')),
  constraint races_persistence_status_chk
    check (persistence_status in ('pending', 'saved', 'partial', 'unsaved')),
  constraint races_events_count_chk
    check (events_count >= 0)
);

create index if not exists races_lifecycle_status_idx
  on races (lifecycle_status);

create index if not exists races_actual_start_time_desc_idx
  on races (actual_start_time desc);

create index if not exists races_actual_end_time_desc_idx
  on races (actual_end_time desc);

create index if not exists races_created_at_desc_idx
  on races (created_at desc);

create index if not exists races_active_lookup_idx
  on races (lifecycle_status, created_at desc)
  where lifecycle_status in ('seeded', 'running', 'results_showing');

create table if not exists race_artifacts (
  id bigserial primary key,
  race_id text not null,
  artifact_type text not null,
  storage_provider text not null,
  storage_key text not null,
  content_type text not null default 'application/json',
  byte_size bigint null,
  checksum text null,
  created_at timestamptz not null default now(),
  constraint race_artifacts_race_fk
    foreign key (race_id)
    references races (race_id)
    on delete cascade,
  constraint race_artifacts_type_chk
    check (artifact_type in ('summary', 'event_timeline', 'final_horse_state_matrix', 'raw_ticks')),
  constraint race_artifacts_storage_provider_chk
    check (storage_provider in ('local_fs', 's3')),
  constraint race_artifacts_byte_size_chk
    check (byte_size is null or byte_size >= 0)
);

create unique index if not exists race_artifacts_race_type_uidx
  on race_artifacts (race_id, artifact_type);

create index if not exists race_artifacts_race_id_idx
  on race_artifacts (race_id);

create index if not exists race_artifacts_type_idx
  on race_artifacts (artifact_type);