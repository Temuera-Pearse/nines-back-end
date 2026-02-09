Race Engine
├─> Persistence Layer (writes ticks, events, race outcomes)
├─> Global Delivery Layer (aggregates & syncs all regions)
│ └─> Regional Broadcasters (per region, handle local fan-out)
│ └─> Clients (worldwide, live race updates)
└─> Betting System (receives race outcomes, settles bets)
└─> Clients (worldwide, place bets, see results)

API / Service Layer
├─> Persistence Layer (reads/writes race history, user data)
├─> Betting System (reads race outcomes, writes/settles bets)
└─> Clients (query balances, bet history, place bets)

# Nines Race Backend

Deterministic race engine and delivery backend for a horse racing game. This service precomputes race ticks, streams them in real time via WebSocket, and manages the race lifecycle and recovery.

## System Architecture

1️⃣ Race Engine (Authoritative Core)

- Purpose: Computes every race accurately and deterministically.
- Responsibilities:
  - Precompute ticks for each race (distance, speed, power-ups).
  - Determine winners and race outcomes.
  - Handle race state machine (countdown → race → results → reset).
  - Store race seeds, last ticks, and minimal memory state.
  - Validate player actions (bets, interactions, power-ups).
- Notes:
  - Stateless instances preferred — can scale horizontally.
  - Could be Node.js services, AWS Lambda functions, or a mix.
  - Only one source of truth for all races.

2️⃣ Broadcasting Layer (Regional Edge Workers)

- Purpose: Deliver real-time race ticks to clients in the same region.
- Responsibilities:
  - Maintain WebSocket connections to thousands of clients per server.
  - Push each tick packet to connected clients.
  - Handle late joins or reconnects (serve latest tick or replay recent ticks).
  - Convert internal tick objects into compact or binary messages for minimal bandwidth.
- Notes:
  - Multiple nodes per region handle horizontal scaling.
  - Subscribes to the Global Delivery Layer for authoritative ticks.

# Nines Race Backend

Understandable guide to a deterministic horse-racing backend. This service precomputes each race, streams ticks to clients in real time, exposes simple APIs for inspection, and saves finished races for audits and replay.

This README is written for junior developers. It explains how things work step by step, provides practical examples, and includes a glossary of common terms.

## Quick Start

1. Install dependencies and run the server (Node 18+):

```bash
npm install
npm run dev
```

2. Open the health check:

```bash
open http://localhost:3001/health
```

3. Explore APIs (examples below) and connect a WebSocket client to watch the live ticks.

## High-Level Overview

- The engine computes the whole race ahead of time (deterministic precompute).
- It creates a timeline of race events (power-ups, hazards) and applies them to horses.
- The result is a canonical “final matrix” of horse state for every tick.
- A WebSocket broadcasts ticks at a regular interval based on this matrix.
- When the race finishes, the backend saves canonical data to disk.

## Project Structure

- Core engine: [src/race/raceEngine.ts](src/race/raceEngine.ts)
- State and lifecycle: [src/race/raceState.ts](src/race/raceState.ts), [src/race/stateMachine.ts](src/race/stateMachine.ts)
- Events: catalog, timeline, and effects
  - [src/race/events/catalog.ts](src/race/events/catalog.ts)
  - [src/race/events/timeline.ts](src/race/events/timeline.ts)
  - [src/race/events/effects.ts](src/race/events/effects.ts)
- WebSocket server: [src/websocket/wsServer.ts](src/websocket/wsServer.ts)
- HTTP API routes: [src/api/raceRoutes.ts](src/api/raceRoutes.ts)
- Metrics: [src/metrics/engineMetrics.ts](src/metrics/engineMetrics.ts)
- Persistence: [src/persistence/racePersistence.ts](src/persistence/racePersistence.ts)
- Server entrypoint: [src/server.ts](src/server.ts)

## How the Race Engine Works

The engine turns a seed into a fully determined race. Here are the main steps:

1. Precompute Base Ticks
   - Create horses with base stats using a single RNG seeded from the current cycle.
   - Build smooth speed curves per horse (no random at runtime).
   - Integrate position per tick with a fixed `dtMs` (e.g., 50ms).
   - Clamp positions at the finish line and compute crossing timestamps.
   - Output: `ticks`, `finishOrder`, `finishTimesMs`, `winnerId`.

2. Build the Event Timeline
   - Deterministic timeline across the race using pacing weights (early/mid/final).
   - Enforces spacing rules and conflict constraints (some events cannot co-exist).
   - Output: `eventTimeline` (immutable map of tick → events).

3. Apply Event Effects → Canonical Final Matrix
   - Convert base paths to per-tick horse states: position, lane, speed.
   - Apply events (stun, boosts, hazards), with deterministic rules.
   - Produce the canonical `finalHorseStateMatrix` (immutable).

4. Validate and Freeze
   - Validate units and semantics (no negative positions, proper clamp, stun rules).
   - Deep-freeze ticks, timeline, and matrix to prevent mutation.
   - Compute a checksum for auditability.

5. Stream and Finish
   - Start the race with a `startTime`, stream ticks via WebSocket at `dtMs` intervals.
   - On finish, broadcast placements and persist canonical artifacts to disk.

## WebSocket Protocol

The server broadcasts messages to all connected clients:

- `race:start` → `{ raceId, horses }`
- `race:tick` → `PositionUpdate[]` (for each horse: `{ horseId, position }`)
- `race:finish` → `{ winner, placements }`

Clients can also reconnect mid-race and catch up using the API endpoints below.

## HTTP API Endpoints

Base path: `http://localhost:3001/race`

- `GET /health`
  - Server status and timestamp.

- `GET /current`
  - Current race summary: config, finish line, start/end times.

- `GET /previous`
  - Last completed race summary (if any).

- `GET /history`
  - Recent race history.

- `GET /ticks/:raceId`
  - Raw precomputed tick objects (before effects).

- `GET /ticks-final/:raceId`
  - Canonical positions by tick from the final matrix.
  - Response: `{ ticksFinal: [{ tickIndex, positions: number[] }] }`

- `GET /timeline/:raceId`
  - Compact event timeline with `{ tick, events: [{ id, instanceId }] }`.

- `GET /results/:raceId`
  - Winner and finish times.

- `GET /metrics`
  - Engine metrics snapshot (tick rate, averages, GC, precompute phases).

Tip: You can use curl or your browser to inspect these endpoints.

## Persistence and Recovery

- When a race finishes, the backend saves a compact summary and canonical artifacts under `data/races/<raceId>/`:
  - `summary.json` (atomic write): seed, outcome, winner, config, checksum.
  - `precomputedPaths.json` (final matrix positions over time).
  - `eventTimeline.json` (tick-indexed compact events).
  - `ticks.json` (optional raw tick stream; may be partial).
- If any write fails, an `UNSAVED.flag` is created for that race and errors are logged.
- On restart, the engine performs recovery to resume streaming and keep the current seed consistent.

## Configuration and Conventions

- Node.js 18+ required; TypeScript strict mode is enabled.
- Motion units:
  - Distance: meters
  - Speed: meters/second
  - Time: milliseconds
- Tick interval (`dtMs`) is 50ms by default → 20 ticks/sec.
- Race duration is ~20s by default (configurable).
- Environment:
  - `LOG_VERBOSE=true` for extra logging (optional).

## Developing Locally

Run the server:

```bash
npm install
npm run dev
```

Try a few endpoints:

```bash
curl http://localhost:3001/health
curl http://localhost:3001/race/current
curl http://localhost:3001/race/metrics
```

Connect a WebSocket client to watch `race:tick` messages. See implementation in [src/websocket/wsServer.ts](src/websocket/wsServer.ts).

Key files to explore:

- Engine core and lifecycle: [src/race/raceEngine.ts](src/race/raceEngine.ts), [src/race/engineLoop.ts](src/race/engineLoop.ts)
- Events and effects: [src/race/events](src/race/events)
- APIs: [src/api/raceRoutes.ts](src/api/raceRoutes.ts)
- Persistence: [src/persistence/racePersistence.ts](src/persistence/racePersistence.ts)
- Metrics: [src/metrics/engineMetrics.ts](src/metrics/engineMetrics.ts)

## Troubleshooting

- “No race seeded” on `/race/current`: Start the engine; it seeds a race and sets `startTime`.
- Drift warnings in logs: The engine compares wall-clock elapsed to tick timing; small drift is expected on busy machines.
- Missing canonical artifacts: The event timeline and final matrix are built during precompute; if missing, check logs for earlier errors.

## Glossary (Junior-Friendly)

- Deterministic: Same inputs produce the exact same outputs every time.
- Seed: A number/string used to initialize the random generator consistently.
- RNG (Random Number Generator): A function that gives pseudo-random values; here it is seeded for determinism.
- Tick: A single time step (e.g., every 50ms) in the race simulation.
- Timeline: A schedule of events placed at specific ticks (e.g., boosts, hazards).
- Event: A power-up or effect that changes a horse’s state (like speed or stun).
- Effect: The actual change applied to a horse because of an event.
- Canonical (Final Matrix): The authoritative per-tick state of each horse after all events are applied.
- Clamp: Limiting a value to a range (e.g., not letting position exceed the finish line).
- Drift: Difference between wall-clock elapsed time and tick-based timing; useful for diagnosing sync issues.
- Placement: The finishing order of horses.
- Winner: The first horse to cross the finish line according to deterministic rules.
- Checksum: A hash used to make sure outputs haven’t changed unexpectedly.
- Persistence: Saving race results and data to disk for later use.
- Recovery: Logic that helps the engine resume safely after a restart.

---

If you’d like more examples or diagrams, or want API samples in Postman, let us know and we can add them!

- Expand watchdog to auto-finish and archive stuck races and to log drift metrics.
- Add status endpoints:
  - GET `/race/status` → phase, race id, start/end times, checksum.
  - GET `/race/current` → minimal snapshot metadata for clients.
- Unit/integration tests:
  - Determinism of ticks with fixed seeds.
  - State machine transitions.
  - Watchdog drift and recovery behavior.
  - WebSocket catch-up windows.

## Run

- Dev (Mac):
  - `npm install`
  - `npm run dev` (requires Node >= 18)
- Build:
  - `npm run build`
  - `npm start`

## WebSocket Protocol (draft)

- `race:info` → sent on connect with current race metadata and snapshot window.
- `race:start` → at start time with horse list and config.
- `race:tick` → streamed positions; 50ms cadence, may skip ahead if behind.
- `race:finish` → winner, placements, finish times.
- `sync:request` → client asks for N recent ticks; server enforces `MAX_CATCHUP_TICKS` and `SYNC_COOLDOWN_MS`.
- `sync:ack` → server responds with ticks, current index, checksum.

## Observability

- Structured logs via `src/utils/logEvent.ts`.
- Key events: precompute summary, scheduler transitions, stream ticks, skips, finish, archive, cleanup, recovery, watchdog warnings.

## Motion & Units

- **Distance:** meters. `trackLength` and per-tick positions are measured in meters.
- **Speed:** meters/second. `baseSpeed` and derived speed curves are in m/s.
- **Variance:** meters/second. `accelVariance` is a shaping amplitude for curve generation, not per-tick acceleration.
- **Tick Duration (`dtMs`):** milliseconds per tick (e.g., 50ms → 20 ticks/sec). Total ticks = floor(`durationMs`/`dtMs`) + 1.
- **Finish Clamp:** Crossing is interpolated within the tick window and positions are deterministically clamped to `finishLine`.
- **Stun Semantics:** Movement halts while `isStunned` is true; the `speed` field remains the base-path speed (for UI/telemetry). Instantaneous offsets (e.g., `hook_shot`, `rocket_boost`) apply at their start tick.

### Predictability & Auditing

- Single seeded RNG drives all precompute; no runtime randomness.
- Canonical `finalHorseStateMatrix` (effects applied) is the single source for visuals, winner, checksums, and persistence.
- Validation logs: unit summary and warnings for any stun-motion anomalies; hard invariants throw if positions exceed `[0, finishLine]`.

### Duration Stability

- `durationMs` and `dtMs` define the tick count deterministically; streaming uses matrix index by `elapsedMs / dtMs`.
- Base speed ranges are chosen to finish ~track length within `durationMs`; effects adjust motion deterministically without changing timing model.
