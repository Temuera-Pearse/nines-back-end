import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { closePool, getPool, verifyPool } from '../db/pool.js'
import { PgRaceRepository } from '../db/raceRepository.js'
import { runRestartRecovery } from '../recovery/restartRecovery.js'
import {
  clearRecoveredRaceRuntime,
  reconstructPersistedRace,
} from '../race/raceEngine.js'
import {
  createRaceLifecycleEvent,
  type NinesRaceLifecycleEventV1,
} from './raceLifecycleContract.js'
import type { NinesRaceResultV1 } from './raceResultContract.js'
import { PgRaceResultOutboxRepository } from './raceResultOutbox.js'
import { getDisposablePostgresTestUrl } from '../testSupport/disposablePostgres.js'

const testDatabaseUrl = getDisposablePostgresTestUrl()
const describeIfDb = testDatabaseUrl ? describe : describe.skip
const fixture = JSON.parse(fs.readFileSync(path.resolve(process.cwd(),
  'contracts/nines-race-lifecycle-v1.fixtures.json'), 'utf8')) as
  Record<string, NinesRaceLifecycleEventV1>
const raceRepository = new PgRaceRepository()
const checksum = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'

async function seedManagedRace(): Promise<void> {
  await raceRepository.upsertSeededRace({
    raceId: fixture.validOpen!.raceId,
    raceRef: fixture.validOpen!.raceRef,
    seed: 'w3-real-postgres-seed',
    scheduledStartTime: new Date(fixture.validOpen!.bettingClosesAt),
    checksum,
    config: { runners: fixture.validOpen!.selections },
    eventsCount: 3,
    lifecycleEvents: [fixture.validOpen!, fixture.validClose!],
  })
}

describeIfDb('authoritative result persistence on real PostgreSQL', () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = testDatabaseUrl!
    process.env.NINES_RACE_DATA_PERSISTENCE_ENABLED = 'true'
    await verifyPool()
  })

  beforeEach(async () => {
    clearRecoveredRaceRuntime()
    await getPool().query(`truncate table race_result_outbox, race_lifecycle_outbox,
      race_artifacts, races restart identity cascade`)
    await seedManagedRace()
  })

  afterAll(async () => {
    await closePool()
    delete process.env.DATABASE_URL
    delete process.env.NINES_RACE_DATA_PERSISTENCE_ENABLED
  })

  it('atomically persists completed race state and immutable result delivery identity', async () => {
    const completion = {
      raceId: fixture.validClose!.raceId,
      actualEndTime: new Date('2026-04-22T12:00:50.000Z'),
      checksum,
      winnerId: 'horse-1',
      finishOrder: ['horse-1', 'horse-2', 'horse-3'],
      finishTimesMs: { 'horse-1': 20_000, 'horse-2': 20_100, 'horse-3': 20_200 },
      config: { runners: fixture.validOpen!.selections },
      hasTickStream: true,
      hasPrecomputedPaths: true,
      eventsCount: 3,
      persistenceStatus: 'saved' as const,
      lifecycleStatus: 'finished' as const,
    }
    await raceRepository.markRaceFinished(completion)
    await raceRepository.markRaceFinished(completion)
    await raceRepository.markRaceFinished({
      ...completion,
      lifecycleStatus: 'results_showing',
    })

    const result = await getPool().query<{ lifecycle_status: string; winner_id: string;
      payload_hash: string; payload: NinesRaceResultV1 }>(`select r.lifecycle_status,r.winner_id,
        o.payload_hash,o.payload from races r join race_result_outbox o using(race_id)
        where r.race_id=$1`, [fixture.validClose!.raceId])
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0]).toMatchObject({ lifecycle_status: 'finished', winner_id: 'horse-1' })
    expect(result.rows[0]!.payload_hash).toBe(result.rows[0]!.payload.evidenceHash)
    expect(result.rows[0]!.payload).toMatchObject({
      raceId: fixture.validClose!.raceId,
      closeLifecycleEventId: fixture.validClose!.lifecycleEventId,
      winningRunnerId: 'horse-1',
      finishOrder: ['horse-1', 'horse-2', 'horse-3'],
    })
  })

  it('rolls back race completion when result outbox persistence cannot commit', async () => {
    await getPool().query(`create function w3_reject_result_insert() returns trigger language plpgsql as $$
      begin raise exception 'injected result outbox failure'; end $$`)
    await getPool().query(`create trigger w3_reject_result_insert before insert on race_result_outbox
      for each row execute function w3_reject_result_insert()`)
    try {
      await expect(raceRepository.markRaceFinished({
        raceId: fixture.validClose!.raceId,
        actualEndTime: new Date('2026-04-22T12:00:50.000Z'),
        checksum,
        winnerId: 'horse-1',
        finishOrder: ['horse-1', 'horse-2', 'horse-3'],
        finishTimesMs: { 'horse-1': 20_000, 'horse-2': 20_100, 'horse-3': 20_200 },
        config: { runners: fixture.validOpen!.selections },
        hasTickStream: true,
        hasPrecomputedPaths: true,
        eventsCount: 3,
        persistenceStatus: 'saved',
        lifecycleStatus: 'finished',
      })).rejects.toThrow('injected result outbox failure')
    } finally {
      await getPool().query('drop trigger if exists w3_reject_result_insert on race_result_outbox')
      await getPool().query('drop function if exists w3_reject_result_insert()')
    }

    const race = await getPool().query<{ lifecycle_status: string; actual_end_time: Date | null }>(
      'select lifecycle_status,actual_end_time from races where race_id=$1',
      [fixture.validClose!.raceId])
    const outbox = await getPool().query<{ count: string }>(
      'select count(*)::text count from race_result_outbox')
    expect(race.rows[0]).toMatchObject({ lifecycle_status: 'seeded', actual_end_time: null })
    expect(outbox.rows[0]?.count).toBe('0')
  })

  it('does not claim a result until the exact race-close event is confirmed delivered', async () => {
    const completion = {
      raceId: fixture.validClose!.raceId,
      actualEndTime: new Date('2026-04-22T12:00:50.000Z'), checksum,
      winnerId: 'horse-1', finishOrder: ['horse-1', 'horse-2', 'horse-3'],
      finishTimesMs: { 'horse-1': 20_000 }, config: {}, hasTickStream: false,
      hasPrecomputedPaths: false, eventsCount: 3, persistenceStatus: 'unsaved' as const,
      lifecycleStatus: 'finished' as const,
    }
    await raceRepository.markRaceFinished(completion)
    const outbox = new PgRaceResultOutboxRepository()
    expect(await outbox.claim(new Date('2026-04-22T12:01:00.000Z'))).toBeNull()

    await getPool().query(`update race_lifecycle_outbox set delivered_at=$2
      where race_id=$1 and lifecycle_sequence=2`, [fixture.validClose!.raceId,
      new Date('2026-04-22T12:00:30.100Z')])
    await expect(outbox.claim(new Date('2026-04-22T12:01:00.000Z')))
      .resolves.toMatchObject({ event: { raceId: fixture.validClose!.raceId } })
  })

  it('rejects unresolved archival without changing the seeded race', async () => {
    await expect(raceRepository.markRaceArchived(fixture.validClose!.raceId))
      .rejects.toThrow('has not durably completed')

    await expect(raceRepository.findRaceById(fixture.validClose!.raceId))
      .resolves.toMatchObject({ lifecycleStatus: 'seeded', winnerId: null })
  })

  it('serializes concurrent completion and archival and makes archival idempotent', async () => {
    const completion = {
      raceId: fixture.validClose!.raceId,
      actualEndTime: new Date('2026-04-22T12:00:50.000Z'), checksum,
      winnerId: 'horse-1', finishOrder: ['horse-1', 'horse-2', 'horse-3'],
      finishTimesMs: { 'horse-1': 20_000 }, config: {}, hasTickStream: false,
      hasPrecomputedPaths: false, eventsCount: 3, persistenceStatus: 'unsaved' as const,
      lifecycleStatus: 'finished' as const,
    }
    const [completed] = await Promise.allSettled([
      raceRepository.markRaceFinished(completion),
      raceRepository.markRaceArchived(completion.raceId),
    ])
    expect(completed.status).toBe('fulfilled')

    await raceRepository.markRaceArchived(completion.raceId)
    await raceRepository.markRaceArchived(completion.raceId)
    await raceRepository.markRaceFinished({
      ...completion,
      lifecycleStatus: 'results_showing',
      hasTickStream: true,
      persistenceStatus: 'saved',
    })

    await expect(raceRepository.markRaceStarted(
      completion.raceId,
      new Date('2026-04-22T12:00:30.000Z'),
    )).rejects.toThrow('cannot transition to running')

    const persisted = await getPool().query<{ lifecycle_status: string; winner_id: string;
      has_tick_stream: boolean; persistence_status: string; result_count: string }>(`
      select r.lifecycle_status,r.winner_id,r.has_tick_stream,r.persistence_status,
        (select count(*)::text from race_result_outbox o where o.race_id=r.race_id) result_count
      from races r where r.race_id=$1`, [completion.raceId])
    expect(persisted.rows[0]).toMatchObject({
      lifecycle_status: 'archived', winner_id: 'horse-1', has_tick_stream: true,
      persistence_status: 'saved', result_count: '1',
    })
  })

  it('recovers a completed result once, then excludes it after durable archival', async () => {
    await getPool().query(`truncate table race_result_outbox, race_lifecycle_outbox,
      race_artifacts, races restart identity cascade`)
    const startTime = new Date(fixture.validClose!.bettingClosesAt)
    const deterministicConfig = {
      trackLength: 1000, finishRatio: 1, durationMs: 20_000, dtMs: 50,
    }
    const rebuilt = reconstructPersistedRace({
      raceId: fixture.validClose!.raceId,
      raceRef: fixture.validClose!.raceRef,
      seed: 'restart-recovery-seed:finish-retry-1',
      config: deterministicConfig,
      bettingOpensAt: fixture.validOpen!.bettingOpensAt,
      bettingClosesAt: fixture.validClose!.bettingClosesAt,
    })
    const race = rebuilt.precomputed
    const endTime = new Date(startTime.getTime() + deterministicConfig.durationMs)
    const selections = race.horses.map((horse) => ({
      runnerId: horse.id, selectionId: horse.id, displayName: horse.name,
    }))
    const commonLifecycle = {
      environment: fixture.validOpen!.environment,
      raceId: race.raceId,
      raceRef: race.raceRef,
      bettingOpensAt: fixture.validOpen!.bettingOpensAt,
      bettingClosesAt: fixture.validClose!.bettingClosesAt,
      selections,
      economicPolicy: fixture.validOpen!.economicPolicy,
      correlationId: race.raceId,
    }
    const openEvent = createRaceLifecycleEvent({
      ...commonLifecycle,
      eventType: 'nines_race_opened.v1',
      causationId: `race-seeded:${race.raceId}`,
      occurredAt: fixture.validOpen!.bettingOpensAt,
    })
    const closeEvent = createRaceLifecycleEvent({
      ...commonLifecycle,
      eventType: 'nines_race_betting_closed.v1',
      causationId: openEvent.lifecycleEventId,
      occurredAt: fixture.validClose!.bettingClosesAt,
    })
    await raceRepository.upsertSeededRace({
      raceId: race.raceId, raceRef: race.raceRef, seed: race.config.seed,
      scheduledStartTime: startTime, checksum: race.checksum ?? null,
      config: deterministicConfig, eventsCount: rebuilt.eventsCount,
      lifecycleEvents: [openEvent, closeEvent],
    })
    await raceRepository.markRaceStarted(race.raceId, startTime)
    const durableCompletion = {
      raceId: race.raceId, actualEndTime: endTime, checksum: race.checksum ?? null,
      winnerId: race.winnerId, finishOrder: [...race.finishOrder],
      finishTimesMs: { ...race.finishTimesMs }, config: deterministicConfig,
      hasTickStream: false, hasPrecomputedPaths: false,
      eventsCount: rebuilt.eventsCount, persistenceStatus: 'unsaved' as const,
      lifecycleStatus: 'results_showing' as const,
    }
    await raceRepository.markRaceFinished(durableCompletion)

    clearRecoveredRaceRuntime()
    const recovered = await runRestartRecovery({
      repository: raceRepository,
      now: new Date(endTime.getTime() + 5_000),
    })
    expect(recovered).toMatchObject({
      inspected: 1, finalized: 1, restoredResultsRaceId: race.raceId,
    })

    // Simulate the crash boundary after durable completion has advanced out of
    // the visible window but before cleanup can archive the row.
    await raceRepository.markRaceFinished({
      ...durableCompletion,
      lifecycleStatus: 'finished',
    })
    clearRecoveredRaceRuntime()
    await expect(runRestartRecovery({
      repository: raceRepository,
      now: new Date(endTime.getTime() + 20_000),
    })).resolves.toMatchObject({ inspected: 1, finalized: 1 })
    clearRecoveredRaceRuntime()
    await expect(runRestartRecovery({
      repository: raceRepository,
      now: new Date(endTime.getTime() + 21_000),
    })).resolves.toMatchObject({ inspected: 0, finalized: 0 })
  })
})
