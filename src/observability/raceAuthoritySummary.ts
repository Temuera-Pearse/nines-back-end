import { engineMetrics } from '../metrics/engineMetrics.js'
import { getOptionalPool, isDatabaseConfigured } from '../db/pool.js'
import { RaceState } from '../race/raceState.js'
import type { RacePhase } from '../race/stateMachine.js'
import { isRunning as isEngineRunning, getEngineLoopSnapshot } from '../race/engineLoop.js'
import {
  getRaceAuthoritySignals,
  observeRaceStateMachine,
} from './raceAuthoritySignals.js'
import {
  getRaceArtifactStoragePolicy,
  getRaceHistoryLimit,
} from './raceAuthorityStoragePolicy.js'
import { getRaceDataPersistencePolicy } from '../persistence/raceDataPersistencePolicy.js'

type ServiceStatus = 'ok' | 'degraded' | 'down'

const phaseOrder: RacePhase[] = [
  'idle',
  'countdown',
  'race_starting',
  'race_running',
  'race_finished',
  'results_showing',
]

const phaseBoundaries: Record<
  RacePhase,
  { startSecond: number; endSecond: number; nextPhase: RacePhase }
> = {
  idle: { startSecond: 0, endSecond: 27, nextPhase: 'countdown' },
  countdown: { startSecond: 27, endSecond: 29, nextPhase: 'race_starting' },
  race_starting: { startSecond: 29, endSecond: 30, nextPhase: 'race_running' },
  race_running: { startSecond: 30, endSecond: 51, nextPhase: 'race_finished' },
  race_finished: { startSecond: 51, endSecond: 51, nextPhase: 'results_showing' },
  results_showing: { startSecond: 51, endSecond: 60, nextPhase: 'idle' },
}

export function startRaceAuthorityObservability(): void {
  observeRaceStateMachine(RaceState.getStateMachine())
}

function phaseBoundaryTimes(now = new Date()) {
  const base = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    now.getUTCHours(),
    now.getUTCMinutes(),
    0,
    0,
  )

  return Object.fromEntries(
    phaseOrder.map((phase) => {
      const boundary = phaseBoundaries[phase]
      return [
        phase,
        {
          startUtc: new Date(base + boundary.startSecond * 1000).toISOString(),
          endUtc: new Date(base + boundary.endSecond * 1000).toISOString(),
        },
      ]
    }),
  )
}

function sanitizeConfig(config: unknown) {
  if (!config || typeof config !== 'object') return config
  const { seed: _seed, ...rest } = config as Record<string, unknown>
  return rest
}

function memoryUsage() {
  const mem = process.memoryUsage()
  return {
    rssBytes: mem.rss,
    heapTotalBytes: mem.heapTotal,
    heapUsedBytes: mem.heapUsed,
    externalBytes: mem.external,
    arrayBuffersBytes: mem.arrayBuffers,
  }
}

async function databaseStatus(): Promise<{
  configured: boolean
  status: 'ok' | 'not_configured' | 'down'
  checkedAt: string
  lastError: string | null
}> {
  const checkedAt = new Date().toISOString()
  if (!isDatabaseConfigured()) {
    return { configured: false, status: 'not_configured', checkedAt, lastError: null }
  }

  try {
    await getOptionalPool()?.query('select 1')
    return { configured: true, status: 'ok', checkedAt, lastError: null }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { configured: true, status: 'down', checkedAt, lastError: message }
  }
}

function serviceStatus(args: {
  databaseDown: boolean
  engineExpected: boolean
  engineRunning: boolean
  lastEngineError: unknown
}): ServiceStatus {
  if (args.databaseDown) return 'degraded'
  if (args.engineExpected && !args.engineRunning) return 'degraded'
  if (args.lastEngineError) return 'degraded'
  return 'ok'
}

export async function getRaceAuthoritySummary() {
  const now = new Date()
  const nowUtc = now.toISOString()
  const sm = RaceState.getStateMachine()
  const { phase, second } = sm.getPhaseAndSecond()
  const pre = RaceState.getPrecomputedRace()
  const currentRace = RaceState.getCurrentRace()
  const previous = RaceState.getPreviousRace()
  const metrics = engineMetrics.getMetrics()
  const loop = getEngineLoopSnapshot()
  const signals = getRaceAuthoritySignals()
  const db = await databaseStatus()
  const storagePolicy = getRaceArtifactStoragePolicy()
  const raceDataPersistence = getRaceDataPersistencePolicy()
  const nextPhase = phaseBoundaries[phase]?.nextPhase ?? 'idle'
  const engineExpected = phase === 'race_running' && currentRace?.isActive === true
  const status = serviceStatus({
    databaseDown: db.status === 'down',
    engineExpected,
    engineRunning: isEngineRunning(),
    lastEngineError: signals.lastEngineError,
  })
  const lastArtifact = signals.lastArtifactWrite
  const lastCompletedRace = previous
  const expectedRaceDurationMs =
    pre?.config?.durationMs ?? previous?.config?.durationMs ?? null
  const raceElapsedMs =
    pre?.startTime && !pre.endTime ? Math.max(0, now.getTime() - pre.startTime.getTime()) : null
  const actualRaceDurationMs =
    lastCompletedRace?.startTime && lastCompletedRace.endTime
      ? lastCompletedRace.endTime.getTime() - lastCompletedRace.startTime.getTime()
      : null

  return {
    server: {
      serviceName: 'nines-back-end',
      status,
      checkedAt: nowUtc,
      nowUtc,
      uptimeSeconds: Math.floor(process.uptime()),
      memory: memoryUsage(),
    },
    lifecycle: {
      currentRaceId: pre?.id ?? currentRace?.id ?? null,
      state: phase,
      phase,
      nextPhase,
      currentCycleSecond: second,
      secondsRemainingInPhase: sm.getRemainingSecondsInState(),
      scheduledPhaseBoundaryTimes: phaseBoundaryTimes(now),
      actualPhaseTransitionTimes: signals.transitionsByPhase,
      lifecycleDriftMs: signals.lastLifecycleTickDriftMs,
      lastTransitionDriftMs: signals.lastTransition?.driftMs ?? null,
      lastTransitionAt: signals.lastTransition?.transitionedAt ?? null,
    },
    raceTiming: {
      expectedRaceDurationMs,
      raceElapsedMs,
      actualRaceDurationMs,
      startCountdownSeconds:
        phase === 'countdown' || phase === 'race_starting'
          ? Math.max(0, 30 - second)
          : null,
      currentRaceConfig: pre?.config ? sanitizeConfig(pre.config) : null,
      lastCompletedRaceId: lastCompletedRace?.id ?? null,
      lastWinnerId: lastCompletedRace?.winnerId ?? null,
    },
    tickHealth: {
      targetIntervalMs: metrics.tickIntervalMs,
      tickRate: metrics.tickRate,
      totalTicks: metrics.ticksTotal,
      actualIntervalAverageMs: metrics.tickWallAvgMs,
      averageDriftMs: metrics.tickDrift.avg,
      p95DriftMs: metrics.tickDrift.p95,
      worstDriftMs: metrics.tickDrift.max,
      skippedOrMissedTicks: 0,
      lastTickTimestamp: loop.lastTickTimeIso,
    },
    websocket: {
      clientsConnected: metrics.ws.clientCount,
      droppedTickFrames: metrics.ws.droppedTickFrames,
      averageBufferedAmount: metrics.ws.avgBufferedAmount,
      sync: metrics.ws.sync,
      fanoutLatencyMs: metrics.ws.broadcast.fanoutMs,
    },
    artifacts: {
      currentRacePersistenceStatus: pre ? 'memory_only' : 'none',
      lastCompletedRacePersistenceStatus: lastArtifact?.status ?? null,
      lastArtifactWriteTime: lastArtifact?.writtenAt ?? null,
      artifactCountsByType: lastArtifact?.artifactCountsByType ?? {},
      lastArtifactError: lastArtifact?.error ?? null,
      storageMode: storagePolicy.storageMode,
      dryRunTarget: storagePolicy.dryRunTarget,
      historyLimit: getRaceHistoryLimit(),
      raceDataPersistence,
    },
    persistence: db,
    errors: {
      lastEngineError: signals.lastEngineError,
      lastWatchdogWarning: signals.lastWatchdogWarning,
    },
  }
}
