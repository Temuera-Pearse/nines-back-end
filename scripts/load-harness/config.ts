import type { LoadHarnessConfig, ScenarioMode, TransportMode } from './types.js'
import path from 'path'

function buildDefaultOutputPath(scenario: ScenarioMode): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  return path.join(
    'artifacts',
    'load-tests',
    `${scenario}-${stamp}.summary.json`,
  )
}

function readNumber(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const value = Number(raw)
  return Number.isFinite(value) ? value : fallback
}

function readPercent(name: string, fallback: number): number {
  return Math.max(0, Math.min(1, readNumber(name, fallback)))
}

function readBoolean(name: string, fallback: boolean): boolean {
  const raw = process.env[name]
  if (!raw) return fallback
  return raw === '1' || raw.toLowerCase() === 'true'
}

function resolveApiBaseUrl(wsUrl: string): string {
  const explicit = process.env.API_URL
  if (explicit && explicit.trim()) return explicit
  const url = new URL(wsUrl)
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:'
  url.pathname = ''
  url.search = ''
  url.hash = ''
  return url.toString().replace(/\/$/, '')
}

export function createHarnessConfig(
  scenario: ScenarioMode,
  overrides: Partial<LoadHarnessConfig> = {},
): LoadHarnessConfig {
  const wsUrl = overrides.wsUrl ?? process.env.WS_URL ?? 'ws://localhost:3001'
  const transportMode: TransportMode =
    overrides.transportMode ??
    (process.env.MODE === 'delta' ? 'delta' : 'plain')

  const defaultDurationMs =
    scenario === 'soak'
      ? 2 * 60 * 60 * 1000
      : scenario === 'reconnect-storm'
        ? 90_000
        : 70_000

  return Object.freeze({
    scenario,
    wsUrl,
    apiBaseUrl: overrides.apiBaseUrl ?? resolveApiBaseUrl(wsUrl),
    clients: overrides.clients ?? readNumber('CLIENTS', 500),
    joinStaggerMs: overrides.joinStaggerMs ?? readNumber('JOIN_STAGGER_MS', 15),
    runDurationMs:
      overrides.runDurationMs ??
      readNumber('RUN_DURATION_MS', defaultDurationMs),
    reportIntervalMs:
      overrides.reportIntervalMs ?? readNumber('REPORT_INTERVAL_MS', 5_000),
    metricsPollIntervalMs:
      overrides.metricsPollIntervalMs ??
      readNumber('METRICS_POLL_INTERVAL_MS', 5_000),
    transportMode,
    binary: overrides.binary ?? readBoolean('BINARY', false),
    token: overrides.token ?? process.env.BROADCAST_TOKEN,
    enableCatchup:
      overrides.enableCatchup ?? readBoolean('ENABLE_CATCHUP', true),
    initialSyncOnInfo:
      overrides.initialSyncOnInfo ?? readBoolean('INITIAL_SYNC_ON_INFO', true),
    reconnectMinDelayMs:
      overrides.reconnectMinDelayMs ??
      readNumber('RECONNECT_MIN_DELAY_MS', 250),
    reconnectMaxDelayMs:
      overrides.reconnectMaxDelayMs ??
      readNumber('RECONNECT_MAX_DELAY_MS', 1_500),
    reconnectSyncTimeoutMs:
      overrides.reconnectSyncTimeoutMs ??
      readNumber('RECONNECT_SYNC_TIMEOUT_MS', 8_000),
    messageDelayMs:
      overrides.messageDelayMs ?? readNumber('MESSAGE_DELAY_MS', 0),
    messageDropChance:
      overrides.messageDropChance ?? readPercent('MESSAGE_DROP_CHANCE', 0),
    slowClientPercent:
      overrides.slowClientPercent ?? readPercent('SLOW_CLIENT_PERCENT', 0),
    slowClientPauseMs:
      overrides.slowClientPauseMs ?? readNumber('SLOW_CLIENT_PAUSE_MS', 0),
    randomDisconnectPercent:
      overrides.randomDisconnectPercent ??
      readPercent('RANDOM_DISCONNECT_PERCENT', 0),
    randomDisconnectIntervalMs:
      overrides.randomDisconnectIntervalMs ??
      readNumber('RANDOM_DISCONNECT_INTERVAL_MS', 10_000),
    stormDisconnectPercent:
      overrides.stormDisconnectPercent ??
      readPercent('STORM_DISCONNECT_PERCENT', 0.4),
    stormTriggerDelayMs:
      overrides.stormTriggerDelayMs ??
      readNumber('STORM_TRIGGER_DELAY_MS', 20_000),
    stormReconnectWindowMs:
      overrides.stormReconnectWindowMs ??
      readNumber('STORM_RECONNECT_WINDOW_MS', 3_000),
    anomalySampleLimit:
      overrides.anomalySampleLimit ?? readNumber('ANOMALY_SAMPLE_LIMIT', 250),
    summaryTopClientCount:
      overrides.summaryTopClientCount ?? readNumber('SUMMARY_TOP_CLIENTS', 10),
    outputPath:
      overrides.outputPath ??
      process.env.OUTPUT_PATH ??
      buildDefaultOutputPath(scenario),
  })
}
