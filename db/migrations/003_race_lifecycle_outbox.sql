create table if not exists race_lifecycle_outbox (
  lifecycle_event_id uuid primary key,
  race_id text not null references races (race_id) on delete restrict,
  race_ref text not null,
  event_type text not null check (event_type in ('nines_race_opened.v1', 'nines_race_betting_closed.v1')),
  lifecycle_sequence integer not null check (lifecycle_sequence in (1, 2)),
  payload jsonb not null,
  payload_hash text not null check (payload_hash ~ '^[0-9a-f]{64}$'),
  available_at timestamptz not null,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  locked_at timestamptz null,
  delivered_at timestamptz null,
  terminal_at timestamptz null,
  last_error text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint race_lifecycle_outbox_race_sequence_uidx unique (race_id, lifecycle_sequence),
  constraint race_lifecycle_outbox_terminal_shape_chk check (
    not (delivered_at is not null and terminal_at is not null)
  )
);

create index if not exists race_lifecycle_outbox_delivery_idx
  on race_lifecycle_outbox (available_at, created_at)
  where delivered_at is null and terminal_at is null;

