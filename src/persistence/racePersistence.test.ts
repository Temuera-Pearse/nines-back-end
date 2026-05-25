import { rm, stat } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getRacePersistence } from './racePersistence.js'
import { getRaceArtifactStoragePolicy } from '../observability/raceAuthorityStoragePolicy.js'
import { isDatabaseConfigured } from '../db/pool.js'
import { getRaceRepository } from '../db/raceRepository.js'
import { getRaceArtifactRepository } from '../db/raceArtifactRepository.js'
import {
  getRaceDataPersistencePolicy,
  resetRaceDataPersistencePolicyForTests,
} from './raceDataPersistencePolicy.js'

type EnvSnapshot = NodeJS.ProcessEnv

let savedEnv: EnvSnapshot

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

function dataDir(prefix: string): string {
  return join(tmpdir(), `${prefix}-${process.pid}-${Date.now()}`)
}

function raceData(raceId: string) {
  return {
    raceId,
    seed: 'private-seed',
    authoritativeFinish: {
      raceId,
      timestampUtc: '2026-05-21T00:00:00.000Z',
      winnerId: 'horse-1',
      finishOrder: ['horse-1'],
      finishTimesMs: { 'horse-1': 1000 },
      finishTickIndex: { 'horse-1': 20 },
      presentation: {
        bannerVisibleUntilUtc: '2026-05-21T00:00:01.000Z',
        resultsVisibleUntilUtc: '2026-05-21T00:00:10.000Z',
      },
    },
    precomputedPaths: [[{ horseId: 'horse-1', position: 1 }]],
    tickStream: [{ timestampOffsetMs: 0, positions: [] }],
    eventTimeline: new Map([[0, [{ id: 'boost', instanceId: 'event-1' } as any]]]),
    outcome: {
      winnerId: 'horse-1',
      finishOrder: ['horse-1'],
      finishTimesMs: { 'horse-1': 1000 },
    },
    winner: {
      horseId: 'horse-1',
      tickIndex: 20,
      timestampMs: 1000,
    },
    config: {
      trackLength: 1000,
      finishRatio: 0.9,
      durationMs: 20000,
      dtMs: 50,
      seed: 'private-seed',
    },
    checksum: 'checksum',
  }
}

beforeEach(() => {
  savedEnv = { ...process.env }
})

afterEach(() => {
  process.env = savedEnv
  resetRaceDataPersistencePolicyForTests()
})

describe('race data persistence policy', () => {
  it('defaults race data persistence to disabled', () => {
    delete process.env.NINES_RACE_DATA_PERSISTENCE_ENABLED

    expect(getRaceDataPersistencePolicy()).toMatchObject({
      enabled: false,
      envDefaultEnabled: false,
      source: 'env_default',
    })
  })

  it('does not write race artifacts or UNSAVED markers when disabled', async () => {
    const dir = dataDir('nines-race-data-disabled')
    process.env.NINES_RACE_DATA_PERSISTENCE_ENABLED = 'false'
    process.env.NINES_ARTIFACT_DRY_RUN = 'false'
    process.env.RACE_DATA_DIR = dir

    const persistence = getRacePersistence()
    const result = await persistence.saveRace('race-disabled-1', raceData('race-disabled-1'))
    persistence.markUnsaved('race-disabled-1')

    expect(result.artifacts).toEqual([])
    expect(result.hasPrecomputedPaths).toBe(false)
    expect(result.hasTickStream).toBe(false)
    expect(await pathExists(dir)).toBe(false)
    expect(await pathExists(join(dir, 'race-disabled-1'))).toBe(false)
  })

  it('writes summary, timeline, precomputed paths, and ticks when enabled', async () => {
    const dir = dataDir('nines-race-data-enabled')
    process.env.NINES_RACE_DATA_PERSISTENCE_ENABLED = 'true'
    process.env.NINES_ARTIFACT_DRY_RUN = 'false'
    process.env.RACE_DATA_DIR = dir

    try {
      const result = await getRacePersistence().saveRace(
        'race-enabled-1',
        raceData('race-enabled-1'),
      )
      const raceDir = join(dir, 'race-enabled-1')

      expect(result.artifacts.map((artifact) => artifact.artifactType).sort()).toEqual([
        'event_timeline',
        'final_horse_state_matrix',
        'raw_ticks',
        'summary',
      ])
      expect(await pathExists(join(raceDir, 'summary.json'))).toBe(true)
      expect(await pathExists(join(raceDir, 'eventTimeline.json'))).toBe(true)
      expect(await pathExists(join(raceDir, 'precomputedPaths.json'))).toBe(true)
      expect(await pathExists(join(raceDir, 'ticks.json'))).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('forces storage and database dependencies off in simulation mode', () => {
    process.env.NINES_SIMULATION_MODE = 'true'
    process.env.NINES_RACE_DATA_PERSISTENCE_ENABLED = 'true'
    process.env.PERSIST_S3_BUCKET = 'production-bucket'
    process.env.DATABASE_URL = 'postgres://example.invalid/nines'

    expect(getRaceArtifactStoragePolicy()).toMatchObject({
      persistArtifacts: false,
      artifactDryRun: false,
      storageMode: 'simulation',
      dryRunTarget: null,
    })
    expect(isDatabaseConfigured()).toBe(false)
  })

  it('skips race metadata and artifact repository writes when disabled', async () => {
    process.env.NINES_RACE_DATA_PERSISTENCE_ENABLED = 'false'
    process.env.DATABASE_URL = 'postgres://example.invalid/nines'

    const raceRepository = getRaceRepository()
    const artifactRepository = getRaceArtifactRepository()

    await expect(
      raceRepository.upsertSeededRace({
        raceId: 'race-sim-db-1',
        seed: 'private-seed',
        config: { durationMs: 20000, dtMs: 50 },
      }),
    ).resolves.toBeUndefined()
    await expect(
      raceRepository.markRaceStarted('race-sim-db-1', new Date()),
    ).resolves.toBeUndefined()
    await expect(
      raceRepository.markRaceFinished({
        raceId: 'race-sim-db-1',
        actualEndTime: new Date(),
        checksum: null,
        winnerId: 'horse-1',
        finishOrder: ['horse-1'],
        finishTimesMs: { 'horse-1': 1000 },
        config: { durationMs: 20000, dtMs: 50 },
        hasTickStream: false,
        hasPrecomputedPaths: false,
        eventsCount: 0,
        persistenceStatus: 'unsaved',
        lifecycleStatus: 'results_showing',
      }),
    ).resolves.toBeUndefined()
    await expect(
      artifactRepository.upsertArtifacts([
        {
          raceId: 'race-sim-db-1',
          artifactType: 'summary',
          storageProvider: 'local_fs',
          storageKey: '/tmp/should-not-be-written',
          contentType: 'application/json',
        },
      ]),
    ).resolves.toBeUndefined()
  })
})
