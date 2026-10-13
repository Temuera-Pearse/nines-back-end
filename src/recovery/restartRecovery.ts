import type { RecoverableRaceRecord } from '../db/types.js'
import {
  getRaceRepository,
  type RaceRepository,
} from '../db/raceRepository.js'
import { isRaceDataPersistenceEnabled } from '../persistence/raceDataPersistencePolicy.js'
import { RaceState } from '../race/raceState.js'
import {
  clearRecoveredRaceRuntime,
  reconstructPersistedRace,
  restoreRecoveredResultsRace,
  restoreRecoveredRunningRace,
  restoreRecoveredSeededRace,
  seedPrecomputedRace,
  type ReconstructedRace,
} from '../race/raceEngine.js'
import type { PrecomputedRace, RaceConfig } from '../race/raceTypes.js'
import { isSimulationMode } from '../runtime/simulationMode.js'
import { logEvent } from '../utils/logEvent.js'

type RecoveryRepository = Pick<
  RaceRepository,
  'listUnresolvedRaces' | 'markRaceStarted' | 'markRaceFinished' | 'markRaceArchived'
>

export type RestartRecoveryReport = Readonly<{
  inspected: number
  finalized: number
  resumedRaceId: string | null
  restoredSeededRaceId: string | null
  restoredResultsRaceId: string | null
}>

type RecoveryCandidate = Readonly<{
  record: RecoverableRaceRecord
  rebuilt: ReconstructedRace
  startTime: Date
  endTime: Date
}>

export type RestartRecoveryOptions = Readonly<{
  repository?: RecoveryRepository
  now?: Date
}>

function regenerateSimulationRace(): void {
  const fixed = process.env.FIXED_SEED?.trim()
  const cycleId = RaceState.bumpCycle()
  RaceState.setCurrentSeed(fixed || `simulation-restart-${cycleId}`)
  const seeded = seedPrecomputedRace()
  RaceState.setPrecomputedRace(seeded)
  logEvent('restart:simulation-regenerated', { raceRef: seeded.raceRef })
}

function requireValidDate(value: Date | null, field: string, raceId: string): Date {
  if (!value || !Number.isFinite(value.getTime())) {
    throw new Error(`Race ${raceId} has no valid ${field}`)
  }
  return new Date(value)
}

function assertRecordIntegrity(
  record: RecoverableRaceRecord,
  rebuilt: ReconstructedRace,
): void {
  const race = rebuilt.precomputed
  if (!record.raceRef) throw new Error(`Race ${record.raceId} has no public race reference`)
  if (!record.seed.trim()) throw new Error(`Race ${record.raceId} has no replay seed`)
  if (record.hasLifecycleOpen !== record.hasLifecycleClose) {
    throw new Error(`Race ${record.raceId} has incomplete lifecycle outbox evidence`)
  }
  if (!record.checksum) throw new Error(`Race ${record.raceId} has no checksum`)
  if (race.checksum !== record.checksum) {
    throw new Error(
      `Race ${record.raceId} checksum mismatch: stored=${record.checksum} rebuilt=${race.checksum ?? 'missing'}`,
    )
  }

  const deterministicConfig: Array<keyof Omit<RaceConfig, 'seed'>> = [
    'trackLength',
    'finishRatio',
    'durationMs',
    'dtMs',
  ]
  for (const key of deterministicConfig) {
    if (record.config[key] !== race.config[key]) {
      throw new Error(
        `Race ${record.raceId} deterministic config mismatch for ${key}`,
      )
    }
  }
  if (record.eventsCount !== rebuilt.eventsCount) {
    throw new Error(`Race ${record.raceId} event count mismatch`)
  }
  if (record.winnerId !== null && record.winnerId !== race.winnerId) {
    throw new Error(`Race ${record.raceId} winner mismatch`)
  }
  if (
    record.finishOrder.length > 0 &&
    JSON.stringify(record.finishOrder) !== JSON.stringify(race.finishOrder)
  ) {
    throw new Error(`Race ${record.raceId} finish order mismatch`)
  }
  if (
    Object.keys(record.finishTimesMs).length > 0 &&
    JSON.stringify(Object.entries(record.finishTimesMs).sort()) !==
      JSON.stringify(Object.entries(race.finishTimesMs).sort())
  ) {
    throw new Error(`Race ${record.raceId} finish times mismatch`)
  }
}

function rebuild(record: RecoverableRaceRecord): ReconstructedRace {
  if (!record.raceRef) throw new Error(`Race ${record.raceId} has no public race reference`)
  const configKeys: Array<keyof Omit<RaceConfig, 'seed'>> = [
    'trackLength',
    'finishRatio',
    'durationMs',
    'dtMs',
  ]
  const config = {} as Omit<RaceConfig, 'seed'>
  for (const key of configKeys) {
    const value = record.config[key]
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      throw new Error(`Race ${record.raceId} has invalid deterministic config ${key}`)
    }
    config[key] = value
  }
  const rebuilt = reconstructPersistedRace({
    raceId: record.raceId,
    raceRef: record.raceRef,
    seed: record.seed,
    config,
    bettingOpensAt: record.bettingOpensAt ?? undefined,
    bettingClosesAt: record.bettingClosesAt ?? undefined,
  })
  assertRecordIntegrity(record, rebuilt)
  return rebuilt
}

function publicConfig(race: PrecomputedRace): Record<string, unknown> {
  return {
    trackLength: race.config.trackLength,
    finishRatio: race.config.finishRatio,
    durationMs: race.config.durationMs,
    dtMs: race.config.dtMs,
  }
}

function resultsVisibleUntil(endTime: Date): number {
  const endMs = endTime.getTime()
  const nextMinute = Math.ceil(endMs / 60_000) * 60_000
  const boundaryDelay = nextMinute - endMs
  return boundaryDelay >= 10_000 && boundaryDelay <= 15_000
    ? nextMinute
    : endMs + 12_000
}

function selectSingleCandidate(
  existing: RecoveryCandidate | null,
  next: RecoveryCandidate,
  kind: string,
): RecoveryCandidate {
  if (existing) {
    throw new Error(
      `Multiple ${kind} races require recovery: ${existing.record.raceId}, ${next.record.raceId}`,
    )
  }
  return next
}

/**
 * Reconcile every unresolved durable race before the UTC lifecycle clock starts.
 * Integrity failures are deliberately fatal: silently producing a different
 * deterministic outcome would violate accepted wagers.
 */
export async function runRestartRecovery(
  options: RestartRecoveryOptions = {},
): Promise<RestartRecoveryReport> {
  if (!options.repository && !isRaceDataPersistenceEnabled()) {
    if (isSimulationMode() && !RaceState.getPrecomputedRace()) {
      regenerateSimulationRace()
    }
    logEvent('restart:persistence-disabled', {})
    return {
      inspected: 0,
      finalized: 0,
      resumedRaceId: null,
      restoredSeededRaceId: null,
      restoredResultsRaceId: null,
    }
  }

  const repository = options.repository ?? getRaceRepository()
  const now = options.now ? new Date(options.now) : new Date()
  const records = await repository.listUnresolvedRaces()
  let finalized = 0
  let running: RecoveryCandidate | null = null
  let seeded: RecoveryCandidate | null = null
  let visibleResult: RecoveryCandidate | null = null

  for (const record of records) {
    const rebuilt = rebuild(record)
    const startTime = requireValidDate(
      record.actualStartTime ?? record.recoveryStartTime,
      'recovery start time',
      record.raceId,
    )
    const deterministicEndTime = new Date(
      startTime.getTime() + rebuilt.precomputed.config.durationMs,
    )
    const endTime = record.actualEndTime
      ? requireValidDate(record.actualEndTime, 'actual end time', record.raceId)
      : deterministicEndTime
    const candidate = { record, rebuilt, startTime, endTime }

    if (record.lifecycleStatus === 'results_showing' || now >= deterministicEndTime) {
      const lifecycleStatus =
        now.getTime() < resultsVisibleUntil(endTime)
          ? 'results_showing' as const
          : 'finished' as const
      const race = rebuilt.precomputed
      await repository.markRaceFinished({
        raceId: record.raceId,
        actualEndTime: endTime,
        checksum: race.checksum ?? null,
        winnerId: race.winnerId,
        finishOrder: [...race.finishOrder],
        finishTimesMs: { ...race.finishTimesMs },
        config: publicConfig(race),
        hasTickStream: record.hasTickStream,
        hasPrecomputedPaths: record.hasPrecomputedPaths,
        eventsCount: rebuilt.eventsCount,
        persistenceStatus:
          record.persistenceStatus === 'pending'
            ? 'unsaved'
            : record.persistenceStatus,
        lifecycleStatus,
      })
      if (lifecycleStatus === 'finished') {
        // A crash between completion and cleanup leaves a durable `finished`
        // row. Archive it through the same guarded transaction before startup
        // proceeds; the next restart will retry if this process dies here.
        await repository.markRaceArchived(record.raceId)
      }
      finalized += 1
      if (lifecycleStatus === 'results_showing') {
        visibleResult = selectSingleCandidate(
          visibleResult,
          candidate,
          'protocol-visible completed',
        )
      }
      logEvent('restart:finalized', {
        raceRef: race.raceRef,
        lifecycleStatus,
        actualEndTime: endTime.toISOString(),
      })
      continue
    }

    if (startTime <= now) {
      running = selectSingleCandidate(running, candidate, 'active')
    } else {
      seeded = selectSingleCandidate(seeded, candidate, 'future seeded')
    }
  }

  if (running && seeded) {
    throw new Error(
      `Cannot recover active race ${running.record.raceId} and future race ${seeded.record.raceId} together`,
    )
  }

  clearRecoveredRaceRuntime()

  if (running) {
    const elapsedMs = Math.max(0, now.getTime() - running.startTime.getTime())
    const resumeTickIndex = Math.floor(
      elapsedMs / running.rebuilt.precomputed.config.dtMs,
    )
    if (running.record.lifecycleStatus === 'seeded') {
      await repository.markRaceStarted(running.record.raceId, running.startTime)
    }
    restoreRecoveredRunningRace(
      running.rebuilt.precomputed,
      running.startTime,
      resumeTickIndex,
    )
    logEvent('restart:resumed', {
      raceRef: running.rebuilt.precomputed.raceRef,
      resumeTickIndex,
    })
  } else if (seeded) {
    restoreRecoveredSeededRace(seeded.rebuilt.precomputed)
    logEvent('restart:seeded-restored', {
      raceRef: seeded.rebuilt.precomputed.raceRef,
      scheduledStartTime: seeded.startTime.toISOString(),
    })
  } else if (visibleResult) {
    restoreRecoveredResultsRace(
      visibleResult.rebuilt.precomputed,
      visibleResult.startTime,
      visibleResult.endTime,
    )
  }

  return {
    inspected: records.length,
    finalized,
    resumedRaceId: running?.record.raceId ?? null,
    restoredSeededRaceId: seeded?.record.raceId ?? null,
    restoredResultsRaceId:
      !running && !seeded ? visibleResult?.record.raceId ?? null : null,
  }
}
