create table if not exists api_service_request_nonces (
  service_id text not null,
  request_id uuid not null,
  sent_at timestamptz not null,
  received_at timestamptz not null default now(),
  primary key (service_id, request_id)
);

create index if not exists api_service_request_nonces_received_idx
  on api_service_request_nonces (received_at);
