# Nines Race Backend

`nines-back-end` is the race authority service for Nines. It owns deterministic
race generation, lifecycle timing, race state, race results, WebSocket race
streaming, and race artifact persistence.

Player, wallet, betting, settlement, financial orchestration, and admin/control
plane code has been migrated out of this repo. Historical migration material is
held in `../nines-api/src/migrated-from-backend`.

## Responsibilities

- Precompute deterministic race ticks from a private seed.
- Build the event timeline and canonical final horse state matrix.
- Determine winners and finish ordering.
- Drive the public race loop: idle, countdown, running, results, reset.
- Stream race state over WebSocket.
- Persist completed race summaries and artifacts.
- Expose safe public race read endpoints.

This service does not own users, wallets, betting, settlement, deposits,
withdrawals, platform modes, Auth0 integration, or operator/admin workflows.

## Public HTTP Surface

Base URL: `http://localhost:3001`

- `GET /health`
- `GET /race/current`
- `GET /race/previous`
- `GET /race/history`
- `GET /race/results/:raceId`
- `GET /race/config`

## Internal Observe-Only Surface

Mission Control uses a separate read-only race authority endpoint:

- `GET /admin/health`
- `GET /internal/race-authority/summary`
- `GET /admin/race-data-persistence`
- `POST /admin/race-data-persistence`

These routes are not part of the public race surface. The internal summary route
is hidden unless
`NINES_ENABLE_INTERNAL_RACE_AUTHORITY=1` is set. In production,
`NINES_INTERNAL_RACE_AUTHORITY_TOKEN` must also be configured and clients must
send it as a bearer token. Local development may run without the token only when
the route is explicitly env-enabled.

`GET /admin/health` is a lightweight admin-compatible alias for `/health`. It
does not require Postgres, persistence, or race artifact access. Local admin
browser origins `http://localhost:5173` and `http://127.0.0.1:5173` are allowed
for this endpoint by default. Add additional comma-separated origins with
`NINES_ADMIN_CORS_ORIGINS`.

The race data persistence admin routes are read/write operational controls. In
production, configure `NINES_RACE_DATA_PERSISTENCE_ADMIN_TOKEN`,
`NINES_ADMIN_TOKEN`, or `NINES_INTERNAL_RACE_AUTHORITY_TOKEN` and send it as a
bearer token. `POST /admin/race-data-persistence` accepts
`{ "enabled": boolean, "reason": "optional text" }` and emits an audit log when
the runtime setting changes.

Completed-race artifact endpoints remain available only after the active race is
complete:

- `GET /race/ticks/:raceId`
- `GET /race/ticks-final/:raceId`
- `GET /race/timeline/:raceId`

The service no longer exposes `/users`, `/bets`, `/settlements`, general
`/admin` mutation routes, `/metrics`, or `/race/metrics`.

## Public Data Safety

Public race summaries and WebSocket `race:info` messages remove deterministic
seed data from race config. Full tick, final-matrix, and timeline artifacts are
blocked for the active race until completion so clients cannot inspect the
outcome early.

Persisted artifacts may still contain private deterministic audit data on disk or
in object storage. Treat artifact storage as backend/internal infrastructure, not
as a public bucket.

For the public race-loop milestone, all race data persistence is disabled by
default with `NINES_RACE_DATA_PERSISTENCE_ENABLED=false`. When disabled, the
runtime does not write race summaries, ticks, timelines, precomputed paths, race
metadata, local artifacts, or S3 artifacts. Enable the full race-data write path
explicitly with `NINES_RACE_DATA_PERSISTENCE_ENABLED=true`; use
`NINES_ARTIFACT_DRY_RUN=true` to report artifact write intent without writing
artifact payloads. In-memory completed-race history is bounded by
`NINES_RACE_HISTORY_LIMIT` (default `10`) so live memory does not grow
indefinitely.

## Simulation Mode

Set `NINES_SIMULATION_MODE=true` for public demo or alpha simulation
deployments:

```bash
NINES_SIMULATION_MODE=true npm run dev
```

When enabled, the service logs:

```text
NINES_SIMULATION_MODE enabled: persistence and financial writes disabled.
```

Simulation mode keeps race generation, lifecycle timing, WebSocket streaming,
engine metrics, public race reads, and internal Mission Control observability
working. It deliberately disables normal-runtime write paths:

- Postgres is not required and `DATABASE_URL` is ignored by the runtime.
- Race metadata writes are skipped.
- Race artifact writes are skipped, even if
  `NINES_RACE_DATA_PERSISTENCE_ENABLED=true`.
- Local `data/races` summaries, ticks, timelines, precomputed paths, and
  `UNSAVED.flag` markers are not written.
- S3 artifact writes are skipped.
- Financial service calls remain absent from this race-authority service.

On restart, simulation mode regenerates in-memory race state and lets the public
race loop continue from memory. This mode is for demos and alpha public race-loop
testing only. It is not suitable for real-money betting, accounting, settlement,
audit, compliance, or any deployment that requires durable replayable race
records.

## Project Structure

- `src/race`: deterministic engine, lifecycle, state machine, events, winner logic.
- `src/websocket`: live race streaming and reconnect catch-up.
- `src/api/raceRoutes.ts`: safe race read endpoints.
- `src/persistence`: race artifact persistence.
- `src/services`: race read/artifact loading services only.
- `src/db`: race metadata and race artifact repositories only.
- `src/metrics`: internal engine metrics used by the runtime.

## Run

```bash
npm install
npm run dev
```

Apply the remaining race metadata migration when using Postgres:

```bash
DATABASE_URL=postgres://localhost:5432/nines_dev npm run db:migrate
```

Backfill existing archived race artifacts into race metadata with:

```bash
DATABASE_URL=postgres://localhost:5432/nines_dev npm run db:backfill:races
```

## Verify

```bash
npm run typecheck
npm test
npm run build
npm run verify
```

Some test environments block local port binding used by Supertest. In that case,
run tests outside the sandbox or with local listen permissions.
