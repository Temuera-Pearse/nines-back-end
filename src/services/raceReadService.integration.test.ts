import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { fileURLToPath } from 'url'
import { closePool, getPool, verifyPool } from '../db/pool.js'
import { PgRaceRepository } from '../db/raceRepository.js'
import { PgRaceArtifactRepository } from '../db/raceArtifactRepository.js'
import { DefaultRaceReadService } from './raceReadService.js'
import { RaceState } from '../race/raceState.js'

const testDatabaseUrl = process.env.TEST_DATABASE_URL
const describeIfDb = testDatabaseUrl ? describe : describe.skip

const raceRepository = new PgRaceRepository()
const artifactRepository = new PgRaceArtifactRepository()

async function applyMigrations(): Promise<void> {
  const migrationPath = fileURLToPath(
    new URL('../../db/migrations/001_alpha_race_metadata.sql', import.meta.url),
  )
  const sql = await fs.readFile(migrationPath, 'utf8')
  await getPool().query(sql)
}

describeIfDb('raceReadService integration', () => {
  let tmpArtifactsDir = ''

  beforeAll(async () => {
    process.env.DATABASE_URL = testDatabaseUrl
    process.env.NINES_RACE_DATA_PERSISTENCE_ENABLED = 'true'
    await verifyPool()
    await applyMigrations()
  })

  beforeEach(async () => {
    RaceState.setCurrentRace(null)
    RaceState.setPrecomputedRace(null)
    RaceState.clearCurrentSeed()
    await getPool().query('truncate table race_artifacts, races restart identity cascade')
    tmpArtifactsDir = await fs.mkdtemp(join(tmpdir(), 'nines-race-read-'))
  })

  afterAll(async () => {
    await closePool()
    delete process.env.DATABASE_URL
    delete process.env.NINES_RACE_DATA_PERSISTENCE_ENABLED
  })

  it('reads current and archived races from Postgres and loads artifact fallbacks from disk', async () => {
    const currentRaceId = 'race-current-db'
    const archivedRaceId = 'race-archived-db'
    const actualStartTime = new Date('2026-03-19T11:00:00.000Z')
    const actualEndTime = new Date('2026-03-19T11:00:20.000Z')

    await raceRepository.upsertSeededRace({
      raceId: currentRaceId,
      seed: 'seed-current',
      checksum: 'checksum-current',
      config: { trackLength: 1000, finishRatio: 1, seed: 'seed-current' },
      eventsCount: 0,
    })

    await raceRepository.upsertSeededRace({
      raceId: archivedRaceId,
      seed: 'seed-archived',
      checksum: 'checksum-archived',
      config: { trackLength: 1000, finishRatio: 1, seed: 'seed-archived' },
      eventsCount: 2,
    })
    await raceRepository.markRaceStarted(archivedRaceId, actualStartTime)
    await raceRepository.markRaceFinished({
      raceId: archivedRaceId,
      actualEndTime,
      checksum: 'checksum-archived',
      winnerId: 'horse-1',
      finishOrder: ['horse-1', 'horse-2'],
      finishTimesMs: { 'horse-1': 20000, 'horse-2': 20120 },
      config: { trackLength: 1000, finishRatio: 1, seed: 'seed-archived' },
      hasTickStream: true,
      hasPrecomputedPaths: true,
      eventsCount: 2,
      persistenceStatus: 'saved',
      lifecycleStatus: 'results_showing',
    })
    await raceRepository.markRaceArchived(archivedRaceId)

    const summaryPath = join(tmpArtifactsDir, 'summary.json')
    const timelinePath = join(tmpArtifactsDir, 'eventTimeline.json')
    const finalTicksPath = join(tmpArtifactsDir, 'precomputedPaths.json')
    const rawTicksPath = join(tmpArtifactsDir, 'ticks.json')

    await fs.writeFile(
      summaryPath,
      JSON.stringify({
        raceId: archivedRaceId,
        seed: 'seed-archived',
        authoritativeFinish: {
          raceId: archivedRaceId,
          timestampUtc: actualEndTime.toISOString(),
          winnerId: 'horse-1',
          finishOrder: ['horse-1', 'horse-2'],
          finishTimesMs: { 'horse-1': 20000, 'horse-2': 20120 },
          finishTickIndex: { 'horse-1': 400, 'horse-2': 402 },
          presentation: {
            bannerVisibleUntilUtc: '2026-03-19T11:00:23.400Z',
            resultsVisibleUntilUtc: '2026-03-19T11:00:32.000Z',
          },
        },
      }),
      'utf8',
    )
    await fs.writeFile(
      timelinePath,
      JSON.stringify([
        { tick: 5, events: [{ id: 'boost', instanceId: 'evt-1' }] },
        { tick: 9, events: [{ id: 'slow', instanceId: 'evt-2' }] },
      ]),
      'utf8',
    )
    await fs.writeFile(
      finalTicksPath,
      JSON.stringify([
        [{ position: 10 }, { position: 8 }],
        [{ position: 25 }, { position: 20 }],
      ]),
      'utf8',
    )
    await fs.writeFile(
      rawTicksPath,
      JSON.stringify([
        { timestampOffsetMs: 0, positions: [{ horseId: 'horse-1', distance: 10 }] },
        { timestampOffsetMs: 50, positions: [{ horseId: 'horse-1', distance: 25 }] },
      ]),
      'utf8',
    )

    await artifactRepository.upsertArtifacts([
      {
        raceId: archivedRaceId,
        artifactType: 'summary',
        storageProvider: 'local_fs',
        storageKey: summaryPath,
        contentType: 'application/json',
        byteSize: (await fs.stat(summaryPath)).size,
      },
      {
        raceId: archivedRaceId,
        artifactType: 'event_timeline',
        storageProvider: 'local_fs',
        storageKey: timelinePath,
        contentType: 'application/json',
        byteSize: (await fs.stat(timelinePath)).size,
      },
      {
        raceId: archivedRaceId,
        artifactType: 'final_horse_state_matrix',
        storageProvider: 'local_fs',
        storageKey: finalTicksPath,
        contentType: 'application/json',
        byteSize: (await fs.stat(finalTicksPath)).size,
      },
      {
        raceId: archivedRaceId,
        artifactType: 'raw_ticks',
        storageProvider: 'local_fs',
        storageKey: rawTicksPath,
        contentType: 'application/json',
        byteSize: (await fs.stat(rawTicksPath)).size,
      },
    ])

    const service = new DefaultRaceReadService()

    const current = await service.getCurrentRaceSummary()
    expect(current).toMatchObject({
      raceId: currentRaceId,
      checksum: 'checksum-current',
      persistenceStatus: 'pending',
      lifecycleStatus: 'seeded',
    })

    const previous = await service.getPreviousRaceSummary()
    expect(previous).toMatchObject({
      raceId: archivedRaceId,
      winnerId: 'horse-1',
      checksum: 'checksum-archived',
      lifecycleStatus: 'archived',
      persistenceStatus: 'saved',
    })

    const history = await service.getRaceHistory(10)
    expect(history).toHaveLength(1)
    expect(history[0]).toMatchObject({ raceId: archivedRaceId })

    const results = await service.getRaceResults(archivedRaceId)
    expect(results).toEqual({
      raceId: archivedRaceId,
      timestampUtc: actualEndTime.toISOString(),
      winnerId: 'horse-1',
      finishOrder: ['horse-1', 'horse-2'],
      finishTimesMs: { 'horse-1': 20000, 'horse-2': 20120 },
      finishTickIndex: { 'horse-1': 400, 'horse-2': 402 },
      presentation: {
        bannerVisibleUntilUtc: '2026-03-19T11:00:23.400Z',
        resultsVisibleUntilUtc: '2026-03-19T11:00:32.000Z',
      },
      winner: 'horse-1',
      placements: ['horse-1', 'horse-2'],
    })

    const timeline = await service.getTimeline(archivedRaceId)
    expect(timeline).toEqual([
      { tick: 5, events: [{ id: 'boost', instanceId: 'evt-1' }] },
      { tick: 9, events: [{ id: 'slow', instanceId: 'evt-2' }] },
    ])

    const finalTicks = await service.getFinalTicks(archivedRaceId)
    expect(finalTicks).toEqual([
      { tickIndex: 0, positions: [10, 8] },
      { tickIndex: 1, positions: [25, 20] },
    ])

    const rawTicks = await service.getRawTicks(archivedRaceId)
    expect(rawTicks).toEqual([
      { timestampOffsetMs: 0, positions: [{ horseId: 'horse-1', distance: 10 }] },
      { timestampOffsetMs: 50, positions: [{ horseId: 'horse-1', distance: 25 }] },
    ])

    const artifacts = await artifactRepository.findArtifactsByRaceId(archivedRaceId)
    expect(artifacts.map((artifact) => artifact.artifactType).sort()).toEqual([
      'event_timeline',
      'final_horse_state_matrix',
      'raw_ticks',
      'summary',
    ])

    await fs.rm(tmpArtifactsDir, { recursive: true, force: true })
  })
})
