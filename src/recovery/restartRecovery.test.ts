import { afterEach, describe, expect, it } from 'vitest'

import type {
  MarkRaceFinishedInput,
  RecoverableRaceRecord,
} from '../db/types.js'
import { activeRaces } from '../race/activeRaceMemory.js'
import { reset as resetEngine } from '../race/engineLoop.js'
import {
  clearRecoveredRaceRuntime,
  reconstructPersistedRace,
} from '../race/raceEngine.js'
import { RaceState } from '../race/raceState.js'
import { runRestartRecovery } from './restartRecovery.js'

const RACE_ID = '018f-restart-recovery-race'
const RACE_REF = 'N9-R1REC-00001'
// The durable seed is the final post-retry seed selected by normal seeding.
const SEED = 'restart-recovery-seed:finish-retry-1'
const CONFIG = {
  trackLength: 1000,
  finishRatio: 1,
  durationMs: 20_000,
  dtMs: 50,
}

function recoverableRecord(input: {
  status: RecoverableRaceRecord['lifecycleStatus']
  startTime: Date
  actualStartTime?: Date | null
  actualEndTime?: Date | null
  includeOutcome?: boolean
}): RecoverableRaceRecord {
  const rebuilt = reconstructPersistedRace({
    raceId: RACE_ID,
    raceRef: RACE_REF,
    seed: SEED,
    config: CONFIG,
    bettingOpensAt: new Date(input.startTime.getTime() - 30_000).toISOString(),
    bettingClosesAt: input.startTime.toISOString(),
  })
  const race = rebuilt.precomputed
  return {
    raceId: RACE_ID,
    raceRef: RACE_REF,
    seed: SEED,
    lifecycleStatus: input.status,
    scheduledStartTime: input.startTime,
    recoveryStartTime: input.startTime,
    actualStartTime: input.actualStartTime ?? null,
    actualEndTime: input.actualEndTime ?? null,
    checksum: race.checksum ?? null,
    winnerId: input.includeOutcome ? race.winnerId : null,
    finishOrder: input.includeOutcome ? [...race.finishOrder] : [],
    finishTimesMs: input.includeOutcome ? { ...race.finishTimesMs } : {},
    config: {
      trackLength: race.config.trackLength,
      finishRatio: race.config.finishRatio,
      durationMs: race.config.durationMs,
      dtMs: race.config.dtMs,
    },
    hasTickStream: false,
    hasPrecomputedPaths: false,
    eventsCount: rebuilt.eventsCount,
    persistenceStatus: input.includeOutcome ? 'unsaved' : 'pending',
    bettingOpensAt: new Date(input.startTime.getTime() - 30_000).toISOString(),
    bettingClosesAt: input.startTime.toISOString(),
    hasLifecycleOpen: true,
    hasLifecycleClose: true,
    createdAt: new Date(input.startTime.getTime() - 30_000),
    updatedAt: new Date(input.startTime.getTime() - 30_000),
  }
}

class FakeRecoveryRepository {
  readonly started: Array<{ raceId: string; startTime: Date }> = []
  readonly finished: MarkRaceFinishedInput[] = []
  readonly archived: string[] = []

  constructor(readonly records: RecoverableRaceRecord[]) {}

  async listUnresolvedRaces(): Promise<RecoverableRaceRecord[]> {
    return this.records
  }

  async markRaceStarted(raceId: string, startTime: Date): Promise<void> {
    this.started.push({ raceId, startTime })
  }

  async markRaceFinished(input: MarkRaceFinishedInput): Promise<void> {
    this.finished.push(input)
  }

  async markRaceArchived(raceId: string): Promise<void> {
    this.archived.push(raceId)
  }
}

afterEach(() => {
  resetEngine()
  clearRecoveredRaceRuntime()
})

describe('PostgreSQL-backed restart recovery', () => {
  it('restores a seeded race during startup with its exact durable identity', async () => {
    const startTime = new Date('2026-10-09T12:00:30.000Z')
    const repository = new FakeRecoveryRepository([
      recoverableRecord({ status: 'seeded', startTime }),
    ])

    const report = await runRestartRecovery({
      repository,
      now: new Date('2026-10-09T12:00:10.000Z'),
    })

    expect(report).toMatchObject({
      inspected: 1,
      finalized: 0,
      restoredSeededRaceId: RACE_ID,
    })
    expect(RaceState.getPrecomputedRace()).toMatchObject({
      raceId: RACE_ID,
      raceRef: RACE_REF,
      config: { seed: SEED },
    })
    expect(RaceState.getCurrentRace()).toBeNull()
    expect(repository.started).toHaveLength(0)
    expect(repository.finished).toHaveLength(0)
  })

  it('resumes a running race at the correct deterministic tick', async () => {
    const startTime = new Date('2026-10-09T12:00:30.000Z')
    const repository = new FakeRecoveryRepository([
      recoverableRecord({
        status: 'running',
        startTime,
        actualStartTime: startTime,
      }),
    ])

    const report = await runRestartRecovery({
      repository,
      now: new Date('2026-10-09T12:00:35.125Z'),
    })

    expect(report.resumedRaceId).toBe(RACE_ID)
    expect(RaceState.getStateMachine().state).toBe('race_running')
    expect(RaceState.getCurrentRace()).toMatchObject({
      raceId: RACE_ID,
      isActive: true,
      lastBroadcastedTick: 101,
    })
    expect(activeRaces.get(RACE_ID)?.currentTickIndex).toBe(101)
    expect(repository.finished).toHaveLength(0)
  })

  it('finalizes an overdue race through durable completion persistence', async () => {
    const startTime = new Date('2026-10-09T12:00:30.000Z')
    const repository = new FakeRecoveryRepository([
      recoverableRecord({
        status: 'running',
        startTime,
        actualStartTime: startTime,
      }),
    ])

    const report = await runRestartRecovery({
      repository,
      now: new Date('2026-10-09T12:01:05.000Z'),
    })

    expect(report).toMatchObject({ inspected: 1, finalized: 1 })
    expect(repository.finished).toHaveLength(1)
    expect(repository.finished[0]).toMatchObject({
      raceId: RACE_ID,
      actualEndTime: new Date('2026-10-09T12:00:50.000Z'),
      lifecycleStatus: 'finished',
      persistenceStatus: 'unsaved',
    })
    expect(repository.finished[0]?.winnerId).toBeTruthy()
    expect(repository.archived).toEqual([RACE_ID])
    expect(RaceState.getCurrentRace()).toBeNull()
  })

  it('produces identical completion evidence on repeated recovery', async () => {
    const startTime = new Date('2026-10-09T12:00:30.000Z')
    const endTime = new Date('2026-10-09T12:00:50.000Z')
    const repository = new FakeRecoveryRepository([
      recoverableRecord({
        status: 'results_showing',
        startTime,
        actualStartTime: startTime,
        actualEndTime: endTime,
        includeOutcome: true,
      }),
    ])
    const now = new Date('2026-10-09T12:00:55.000Z')

    await runRestartRecovery({ repository, now })
    await runRestartRecovery({ repository, now })

    expect(repository.finished).toHaveLength(2)
    expect(repository.finished[1]).toEqual(repository.finished[0])
    expect(repository.finished[0]).toMatchObject({
      actualEndTime: endTime,
      lifecycleStatus: 'results_showing',
    })
    expect(RaceState.getPrecomputedRace()?.authoritativeFinish?.timestampUtc)
      .toBe(endTime.toISOString())
  })

  it('refuses to recover when durable checksum evidence does not match', async () => {
    const startTime = new Date('2026-10-09T12:00:30.000Z')
    const record = recoverableRecord({ status: 'seeded', startTime })
    record.checksum = '0'.repeat(64)
    const repository = new FakeRecoveryRepository([record])

    await expect(runRestartRecovery({
      repository,
      now: new Date('2026-10-09T12:00:10.000Z'),
    })).rejects.toThrow('checksum mismatch')
  })
})
