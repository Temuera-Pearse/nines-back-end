# Global Broadcast Roadmap & Tickets

Goal: Single Source of Truth (SOT) server broadcasting race ticks to tens of thousands of concurrent viewers worldwide, with deterministic, cheat‑resistant clients.

## Phasing (Recommended Order)

1. Protocol hardening + WS resilience (baseline load tests)
2. Payload efficiency (keyframes, binary) + client metrics
3. Multi‑region bus + edge broadcasters + geo routing
4. Resilience, failover, security, and observability
5. Infra automation + frontend SDK

---

## T1 — Add Tick Sequencing + Timestamps

- Summary: Include `seq` (monotonic) and `tickTs` (ms) in `race:tick` payloads.
- Tasks:
  - Extend `RaceWebSocketServer.broadcast()` to attach `seq`, `tickIndex`, `tickTs`.
  - Track `seq` in memory per race; reset at race start.
  - Surface `seq` in `/race/metrics` for monitoring.
- Acceptance Criteria:
  - Clients receive ordered frames; out‑of‑order frames can be dropped by `seq`.
  - Metrics show latest `seq` per race.
- Dependencies: None
- Priority: High

## T2 — Sign Tick Frames (Ed25519)

- Summary: Sign each tick payload; expose public key for client verification.
- Tasks:
  - Add signer module (Ed25519) with key management (env/SSM parameter).
  - Attach `signature` to `race:tick` and `race:finish`.
  - Add `/race/config` endpoint to return public key and config.
- Acceptance Criteria:
  - Clients verify signature successfully; tampered frames fail verification.
- Dependencies: T1
- Priority: High

## T3 — Implement Keyframes + Delta Ticks

- Summary: Reduce bandwidth by sending full position snapshots at intervals and deltas in between.
- Tasks:
  - Define keyframe cadence (e.g., every 1000ms).
  - Delta format: per horse position diff since last frame.
  - Server ensures latest keyframe is sent before deltas after reconnect.
- Acceptance Criteria:
  - Bandwidth decreases measurably; clients stay consistent after reconnect.
- Dependencies: T1
- Priority: High

## T4 — Optional Binary Tick Payload

- Summary: Support `Float32Array` positions + compact frame header; fallback to JSON.
- Tasks:
  - Content‑type negotiation (URL param or message type flag).
  - Encode positions into typed arrays; serialize efficiently.
- Acceptance Criteria:
  - Binary mode reduces per‑frame size and CPU without correctness issues.
- Dependencies: T1, T3
- Priority: Medium

## T5 — WS Backpressure Skip + Keepalive

- Summary: Prevent event‑loop stalls; prune dead sockets.
- Tasks:
  - Skip `race:tick` for clients with high `bufferedAmount` (protect keyframes).
  - Add ping/pong every 30s; terminate unresponsive sockets.
- Acceptance Criteria:
  - Drop rate within thresholds; CPU stays stable under load.
- Dependencies: None
- Priority: High

## T6 — Broadcast Logging Control + Batching

- Summary: Reduce logging overhead and allow small frame batching when warranted.
- Tasks:
  - Gate logs behind `LOG_VERBOSE`.
  - Optionally batch micro frames (configurable) without added latency.
- Acceptance Criteria:
  - Logs don’t degrade throughput; batching configurable and safe.
- Dependencies: None
- Priority: Medium

## T7 — Client Metrics: Counts & Drops

- Summary: Visibility into capacity and quality.
- Tasks:
  - Track `clientCount`, `droppedTickFrames`, average `bufferedAmount`.
  - Expose via `/race/metrics` and periodic logs/alerts.
- Acceptance Criteria:
  - Metrics visible; alarms can be set at thresholds.
- Dependencies: T5
- Priority: High

## T8 — Catch‑up API + Rate Limits

- Summary: Robust reconnect/catch‑up path with guardrails.
- Tasks:
  - Ensure latest keyframe + window of ticks is returned.
  - Enforce per‑client cooldown and max window size.
- Acceptance Criteria:
  - Reconnect yields consistent state; abuse prevented by limits.
- Dependencies: T3
- Priority: High

## T9 — Switch Persistence to S3

- Summary: Durable, cost‑effective storage with replication.
- Tasks:
  - Replace local file writes with S3 PUTs; add bucket config/env.
  - Optionally enable versioning and cross‑region replication.
- Acceptance Criteria:
  - Completed races persist in S3; audit files retrievable.
- Dependencies: None
- Priority: Medium

## T10 — Add Redis/NATS Publisher (SOT)

- Summary: Pluggable publisher for ticks/events to a bus.
- Tasks:
  - Publisher interface; Redis Streams or NATS JetStream implementation.
  - Backpressure handling and retention policy (e.g., 10s).
  - Optional ElastiCache Redis window (5–10s) to accelerate catch‑up separate from bus.
- Acceptance Criteria:
  - SOT publishes frames reliably; bus retains brief window.
- Dependencies: T1–T4
- Priority: High

## T11 — Edge Subscriber Broadcaster

- Summary: Stateless edge service consuming bus and rebroadcasting via WS.
- Tasks:
  - Subscriber implementation with reconnect/resubscribe.
  - Local ring buffer for catch‑up; apply T5/T7 policies.
  - Integrate ElastiCache Redis for fast retrieval of latest keyframe + recent ticks.
- Acceptance Criteria:
  - Edges rebroadcast reliably; recover from transient failures.
- Dependencies: T10
- Priority: High

## T12 — Geo Routing (Route53/Global Accelerator)

- Summary: Direct clients to nearest region; maintain stickiness.
- Tasks:
  - Configure latency‑based routing or Global Accelerator.
  - Ensure LB stickiness and region failover.
- Acceptance Criteria:
  - Clients connect to closest region; failover is smooth.
- Dependencies: T11
- Priority: Medium

## T13 — Metrics/Alerts (Prometheus/CloudWatch)

- Summary: Observability for engine and edges.
- Tasks:
  - Publish metrics (client count, drops, latency, GC).
  - CloudWatch alarms or Prometheus alerts for thresholds.
  - Propagate `seq/tickIndex` across SOT → bus → edge to measure end‑to‑end latency.
- Acceptance Criteria:
  - Actionable dashboards and alerts in place.
- Dependencies: T7
- Priority: High

## T14 — SOT Failover + Leader Election

- Summary: High availability for the source of truth.
- Tasks:
  - Implement leader election (Redis Redlock) and warm standby.
  - Seamless takeover of publishing on failure.
- Acceptance Criteria:
  - SOT failure does not stop broadcast; handover within seconds.
- Dependencies: T10
- Priority: High

## T15 — Security Hardening (TLS/WAF/Token)

- Summary: Protect endpoints and streams.
- Tasks:
  - Enforce TLS; configure WAF rules; rate‑limit sync.
  - Optional access tokens for race channels.
- Acceptance Criteria:
  - Only secure WS/HTTP allowed; basic abuse mitigated.
- Dependencies: None
- Priority: High

## T16 — Load Test to 20k Clients

- Summary: Validate capacity under realistic conditions.
- Tasks:
  - Artillery/K6 scenarios for 10k–20k WS clients at 20 Hz.
  - Measure end‑to‑end latency, drop rate, CPU/NIC, memory.
- Acceptance Criteria:
  - <150 ms latency, <1% drop, resources within limits.
- Dependencies: T1–T8
- Priority: High

## T17 — Terraform/CDK for AWS Infra

- Summary: Reproducible multi‑region deployment.
- Tasks:
  - VPC, ALB/NLB, ECS/EKS, ElastiCache/NATS, S3, Route53/Accelerator.
  - Autoscaling policies, alarms, ACM certificates, WAF.
- Acceptance Criteria:
  - One‑command deploys; environment parity across regions.
- Dependencies: T10–T12
- Priority: Medium

## T18 — Frontend Client SDK (WS + Binary)

- Summary: Simple SDK for consuming ticks efficiently.
- Tasks:
  - Connect, verify signatures, decode JSON/binary frames.
  - Catch‑up + smoothing; event overlays support.
- Acceptance Criteria:
  - Integrators can render races with minimal effort.
- Dependencies: T1–T4, T8
- Priority: Medium

---

## Milestones

- M1 (Baseline): T1, T5, T6, T7, T8 — Single node stable to 5k.
- M2 (Efficiency): T3, T4 — Reduced bandwidth; 10k target.
- M3 (Global): T10, T11, T12 — Multi‑region edges; 10k–20k.
- M4 (HA/Sec/Obs): T2, T9, T13, T14, T15 — Production‑grade.
- M5 (Infra/DevEx): T16, T17, T18 — Scale validation, automation, SDK.
