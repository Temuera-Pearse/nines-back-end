# Backend Load Testing Runbook

## Purpose

Use the existing load harness to validate websocket delivery, reconnect recovery, soak stability, and finish/result correctness before wider rollout.

The harness produces:

- a JSON summary file under `artifacts/load-tests/` by default
- streamed JSONL events on stdout for snapshots and anomaly samples
- a final human-readable summary on stderr with `PASS`, `WARN`, or `FAIL`

## Prerequisites

- Node.js 18+
- backend dependencies installed with `npm install`
- backend server running locally or reachable over HTTP/WebSocket
- race engine healthy enough to serve `/race/metrics`, `/metrics`, and `/race/results/:raceId`

## Start The Backend

Typical local start:

```bash
npm run dev
```

If the backend is not on the default local ports, set:

```bash
export API_BASE_URL=http://127.0.0.1:3001
export WS_URL=ws://127.0.0.1:3001/ws
```

## Core Modes

Baseline:

```bash
npm run load:test
```

Reconnect storm:

```bash
npm run load:test:reconnect
```

Soak:

```bash
npm run load:test:soak
```

Clustered baseline:

```bash
npm run load:test:cluster
```

Compare two completed runs:

```bash
npm run load:test:compare -- artifacts/load-tests/baseline-a.summary.json artifacts/load-tests/baseline-b.summary.json
```

## High Value Environment Variables

- `CLIENTS`: total simulated websocket clients
- `RUN_DURATION_MS`: total scenario runtime
- `REPORT_INTERVAL_MS`: snapshot interval
- `METRICS_POLL_INTERVAL_MS`: backend metric polling interval
- `JOIN_STAGGER_MS`: client connection stagger
- `OUTPUT_PATH`: explicit summary JSON path
- `TRANSPORT_MODE`: `plain` or `delta`
- `BINARY`: `1` to enable binary tick frames
- `ENABLE_CATCHUP`: `1` to request catch-up/sync flows
- `INITIAL_SYNC_ON_INFO`: `1` to sync immediately on `race:info`
- `RANDOM_DISCONNECT_PERCENT`: background reconnect churn during baseline or soak
- `STORM_DISCONNECT_PERCENT`: fraction disconnected during reconnect storm
- `STORM_TRIGGER_DELAY_MS`: time before storm injection starts
- `STORM_RECONNECT_WINDOW_MS`: reconnect spread window for storm clients
- `MESSAGE_DELAY_MS`: artificial per-message client delay
- `MESSAGE_DROP_CHANCE`: artificial client-side message drop rate
- `SLOW_CLIENT_PERCENT`: fraction of paused socket readers
- `SLOW_CLIENT_PAUSE_MS`: pause duration for slow clients

## Example Commands

Short baseline:

```bash
CLIENTS=100 RUN_DURATION_MS=45000 npm run load:test
```

Reconnect storm with catch-up enabled:

```bash
CLIENTS=300 RUN_DURATION_MS=90000 ENABLE_CATCHUP=1 INITIAL_SYNC_ON_INFO=1 npm run load:test:reconnect
```

Two-hour soak with mild background churn:

```bash
CLIENTS=250 RUN_DURATION_MS=7200000 RANDOM_DISCONNECT_PERCENT=0.02 RANDOM_DISCONNECT_INTERVAL_MS=10000 npm run load:test:soak
```

Explicit output file:

```bash
OUTPUT_PATH=artifacts/load-tests/pre-release.summary.json npm run load:test
```

## Output Location

If `OUTPUT_PATH` is not set, the harness writes the final summary JSON to:

```text
artifacts/load-tests/<scenario>-<timestamp>.summary.json
```

This file is the canonical input for comparisons and release-gate reviews.

## Alpha Thresholds

The harness evaluates these thresholds automatically and emits `PASS`, `WARN`, or `FAIL`:

- Sequence gaps:
  - normal runs: pass only at `0`, warn up to `0.0001` missing-frame ratio, fail above that
  - intentionally lossy runs: pass up to `0.0005`, warn up to `0.005`
- Sequence regressions: pass at `0`, fail above `0`
- Reconnect success rate: pass `>= 99.5%`, warn `>= 98%`, fail below `98%`
- Sync latency average: pass `<= 750ms`, warn `<= 1500ms`, fail above `1500ms`
- Sync latency p95: pass `<= 1500ms`, warn `<= 3000ms`, fail above `3000ms`
- Message latency average: pass `<= 120ms`, warn `<= 250ms`, fail above `250ms`
- Message latency p95: pass `<= 250ms`, warn `<= 500ms`, fail above `500ms`
- Catch-up latency p95: pass `<= 150ms`, warn `<= 400ms`, fail above `400ms`
- Event-loop lag mean: pass `<= 20ms`, warn `<= 50ms`, fail above `50ms`
- Event-loop lag p95: pass `<= 40ms`, warn `<= 100ms`, fail above `100ms`
- Soak memory growth: pass `<= 128MB`, warn `<= 256MB`, fail above `256MB`
- Server tick CPU average max: pass `<= 8ms`, warn `<= 15ms`, fail above `15ms`
- Finish/result mismatches: pass at `0`, fail above `0`

## How To Read The Summary

Important top-level fields:

- `verdict`: overall release-gate result
- `topIssues`: highest priority degraded metrics
- `firstFailedMetric`: first threshold category to investigate
- `investigateNext`: direct operator guidance
- `thresholdResults`: per-metric verdicts and actual values
- `p95LatencyMs`: end-to-end client-observed message latency p95
- `syncLatencyP95Ms`: client-observed sync completion p95
- `maxServerCatchupP95Ms`: server-reported catch-up service p95
- `eventLoopLagMeanMs` and `eventLoopLagP95Ms`: harness runtime stability indicators
- `serverResidentMemoryGrowthMb`: preferred soak memory signal when backend metrics are available
- `resultMismatches`: correctness guardrail for finish delivery versus persisted results

## Release Gate Guidance

- `PASS`: acceptable alpha run for the tested scenario size
- `WARN`: usable but not clean; investigate before increasing scale or rollout scope
- `FAIL`: do not treat this scenario as production-ready until the failed metric is explained or fixed

## Minimal Operator Flow

1. Start the backend.
2. Run a baseline.
3. Run a reconnect storm.
4. Run a soak.
5. Compare the latest run against the previous known-good summary.
6. Investigate the first failed metric before chasing lower-priority warnings.
