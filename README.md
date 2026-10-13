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
- `GET /race/results/:raceRef`
- `GET /race/config`

## Internal Observe-Only Surface

Mission Control uses a separate read-only race authority endpoint:

- `GET /admin/health`
- `GET /admin/race/overview`
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
does not require Postgres, persistence, or race artifact access.
`GET /admin/race/overview` exposes the same sanitized race-authority read model
as the internal summary endpoint through a browser-safe admin path. Local admin
browser origins `http://localhost:5173`, `http://127.0.0.1:5173`,
`http://localhost:5174`, and `http://127.0.0.1:5174` are allowed for these
read-only admin endpoints by default. Add additional comma-separated origins
with `NINES_ADMIN_CORS_ORIGINS`.

The race data persistence admin routes are read/write operational controls. In
production, configure `NINES_RACE_DATA_PERSISTENCE_ADMIN_TOKEN`,
`NINES_ADMIN_TOKEN`, or `NINES_INTERNAL_RACE_AUTHORITY_TOKEN` and send it as a
bearer token. `POST /admin/race-data-persistence` accepts
`{ "enabled": boolean, "reason": "optional text" }` and emits an audit log when
the runtime setting changes.

Completed-race artifact endpoints remain available only after the active race is
complete:

- `GET /race/ticks/:raceRef`
- `GET /race/ticks-final/:raceRef`
- `GET /race/timeline/:raceRef`

The service no longer exposes `/users`, `/bets`, `/settlements`, general
`/admin` mutation routes, `/metrics`, or `/race/metrics`.

## Public Data Safety

Public REST and WebSocket contracts identify races only with `raceRef`, a
cryptographically random `N9-XXXXX-XXXXX` Crockford Base32 reference. The
private `raceId` remains an internal persistence/coordination key and is never
derived from, or exposed alongside, the private deterministic seed. Legacy
records without a stored `raceRef` remain explicitly unavailable by reference.
This identity-field change is WebSocket protocol version 2; clients must send
`raceRef` in `sync:request` and receive `raceRef` on all race messages.

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
- Authenticated Financial wager submission is available as a library client,
  but simulation mode does not invoke it automatically.

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
- `src/financial`: authenticated NINES wager and race-lifecycle contracts, clients, and durable delivery.

## Stage W1 Financial wager client

`NinesFinancialWagerClient` sends the immutable `NinesPlaceBetCommandV1` to
Financial with HMAC method/path/environment/body binding. Each retry uses a new
transport nonce and signature while retaining `betId`, stake, and economic
idempotency identity. Production configuration requires
`NINES_FINANCIAL_BASE_URL` (HTTPS), `NINES_FINANCIAL_AUTH_KEY_ID`, and
`NINES_FINANCIAL_AUTH_HMAC_SECRET`; timeout and attempts default to 3000 ms and
2 respectively.

The contract maps the private backend `race_id` to Financial `raceId`, making
it the economic primary key. Public `race_ref` is display/correlation evidence
only. The versioned player assertion must be created from an already
authenticated upstream player context and binds its subject to `playerId`.
W1 does not add a public betting route or durable backend command table: the
caller owns the stable command identity, and lost synchronous responses are
recovered by resubmitting the same command.

## Stage W2 race lifecycle delivery

When `NINES_FINANCIAL_RACE_LIFECYCLE_ENABLED=true`, seeding a durably persisted
race atomically records immutable `nines_race_opened.v1` and scheduled
`nines_race_betting_closed.v1` events in `race_lifecycle_outbox`. The open event
is immediately eligible; the close event becomes eligible at the authoritative
race-start/betting-close timestamp. Delivery retries preserve the event body and
economic identity while renewing the HMAC timestamp and transport nonce.

The backend `raceId` is the Financial economic identity, `raceRef` remains the
public reference, and each horse ID maps directly to the Financial selection ID.
The policy snapshot requires an explicit `NINES_RACE_HOUSE_TAKE_BPS`; there is
no inferred production default. Durable delivery also requires
`NINES_RACE_DATA_PERSISTENCE_ENABLED=true`, `DATABASE_URL`,
`NINES_FINANCIAL_BASE_URL`, `NINES_FINANCIAL_AUTH_KEY_ID`, and
`NINES_FINANCIAL_AUTH_HMAC_SECRET`. Optional poll, timeout, and attempt settings
use the `NINES_FINANCIAL_RACE_LIFECYCLE_*` prefix.

Authenticated browser wagers enter through nines-api and reach the narrow
`POST /internal/v1/player-wagers` gateway. Enable it with
`NINES_API_PLAYER_WAGER_ENABLED=1` and configure the dedicated
`NINES_API_AUTH_KEY_ID` / `NINES_API_AUTH_HMAC_SECRET` pair. The gateway maps
the public race reference to the private race identity; it never accepts a
browser-supplied private race ID. Apply migration
`005_player_wager_gateway.sql` before enabling it.

## Stage W3 authoritative result delivery

For W2-managed races, durable race completion and insertion of an immutable
`nines_race_completed.v1` event into `race_result_outbox` occur in the same
PostgreSQL transaction. The result is derived from the persisted W2 close
evidence and the backend's actual winner, finish order, completion timestamp,
and race checksum. A deterministic result ID and canonical evidence hash remain
stable across retries and restarts.

The result worker reuses the W2 Financial delivery configuration and HMAC
credentials. It sends `POST /internal/v1/race-results` without holding a
database transaction, uses a fresh timestamp and nonce for every HTTP attempt,
and records the durable Financial settlement acknowledgement. Retryable
outages/timeouts remain pending; a conflict is retained as a terminal delivery
failure for operator investigation. Production delivery requires HTTPS.

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
