import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { getRaceRepository } from '../db/raceRepository.js'
import { RaceWebSocketServer } from '../websocket/wsServer.js'
import { activeRaces } from './activeRaceMemory.js'
import { computeRaceChecksum } from './checksum.js'
import { createOpaqueRaceId } from './raceId.js'
import {
  seedPrecomputedRace,
  startPrecomputedRace,
  streamPrecomputedTickAt,
} from './raceEngine.js'
import { hashStringToInt } from './rng.js'
import { RaceState } from './raceState.js'
import type { PrecomputedRace } from './raceTypes.js'

const PRIVATE_KEYS = new Set([
  'seed',
  'privateSeed',
  'seedInt',
  'rngSeed',
  'effectKey',
])

let savedEnv: NodeJS.ProcessEnv

function publicGenerationArtifacts(race: PrecomputedRace) {
  const { seed: _privateSeed, ...publicConfig } = race.config
  return {
    config: publicConfig,
    horses: race.horses,
    ticks: race.ticks,
    finishLine: race.finishLine,
    winnerId: race.winnerId,
    finishOrder: race.finishOrder,
    finishTimesMs: race.finishTimesMs,
    finishTickIndex: race.finishTickIndex,
    eventTimeline: Array.from(race.eventTimeline?.entries() ?? []),
    finalHorseStateMatrix: race.finalHorseStateMatrix,
    checksum: race.checksum,
  }
}

function collectKeys(value: unknown, keys = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, keys)
    return keys
  }
  if (!value || typeof value !== 'object') return keys
  for (const [key, child] of Object.entries(value)) {
    keys.add(key)
    collectKeys(child, keys)
  }
  return keys
}

beforeEach(() => {
  savedEnv = { ...process.env }
  process.env.NINES_RACE_DATA_PERSISTENCE_ENABLED = 'false'
  RaceState.setPrecomputedRace(null)
  RaceState.setCurrentRace(null)
  RaceState.clearCurrentSeed()
  RaceState.getStateMachine().state = 'idle'
  activeRaces.clear()
})

afterEach(() => {
  process.env = savedEnv
  RaceState.setPrecomputedRace(null)
  RaceState.setCurrentRace(null)
  RaceState.clearCurrentSeed()
  RaceState.getStateMachine().state = 'idle'
  activeRaces.clear()
  vi.restoreAllMocks()
})

describe('opaque public race identity', () => {
  it('uses the established race prefix with a cryptographically random UUID', () => {
    expect(createOpaqueRaceId()).toMatch(
      /^race-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
  })

  it('keeps race identity independent and stable through retries and lifecycle', async () => {
    const privateSeed = 'horse-count-test'
    const firstId = 'race-00000000-0000-4000-8000-000000000001'
    const secondId = 'race-00000000-0000-4000-8000-000000000002'
    const firstIdFactory = vi.fn(() => firstId)
    const secondIdFactory = vi.fn(() => secondId)
    const broadcasts: unknown[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(RaceWebSocketServer, 'broadcast').mockImplementation((message) => {
      broadcasts.push(message)
    })
    const repository = getRaceRepository()
    const upsertSpy = vi
      .spyOn(repository, 'upsertSeededRace')
      .mockResolvedValue(undefined)
    const startSpy = vi
      .spyOn(repository, 'markRaceStarted')
      .mockResolvedValue(undefined)
    const finishSpy = vi
      .spyOn(repository, 'markRaceFinished')
      .mockResolvedValue(undefined)

    RaceState.setCurrentSeed(privateSeed)
    const first = seedPrecomputedRace(firstIdFactory)
    RaceState.setCurrentSeed(privateSeed)
    const second = seedPrecomputedRace(secondIdFactory)

    expect(first.id).toBe(firstId)
    expect(second.id).toBe(secondId)
    expect(firstIdFactory).toHaveBeenCalledTimes(1)
    expect(secondIdFactory).toHaveBeenCalledTimes(1)
    expect(first.config.seed).toMatch(`${privateSeed}:finish-retry-`)
    expect(second.config.seed).toBe(first.config.seed)
    expect(publicGenerationArtifacts(second)).toEqual(
      publicGenerationArtifacts(first),
    )

    for (const internalSeed of [privateSeed, second.config.seed]) {
      const seedInt = hashStringToInt(internalSeed)
      expect(second.id).not.toContain(seedInt.toString(10))
      expect(second.id).not.toContain(seedInt.toString(16))
      expect(second.id).not.toContain(seedInt.toString(16).padStart(8, '0'))
    }

    const checksumWithoutPrivateMetadata = computeRaceChecksum({
      ...second,
      id: 'race-another-public-id',
      config: { ...second.config, seed: 'different-private-seed' },
      seedInt: 123,
      horses: second.horses.map((horse) => ({
        ...horse,
        rngSeed: horse.rngSeed + 1,
      })),
    })
    expect(checksumWithoutPrivateMetadata).toBe(second.checksum)

    RaceState.setPrecomputedRace(second)
    RaceState.getStateMachine().state = 'countdown'
    expect(RaceState.getPrecomputedRace()?.id).toBe(secondId)
    RaceState.getStateMachine().transition('race_starting')
    const startTime = new Date('2026-07-18T00:00:30.000Z')
    expect(startPrecomputedRace(startTime).id).toBe(secondId)
    streamPrecomputedTickAt(second.ticks.length - 1)

    const scopedMessages = broadcasts.filter((message: any) => {
      const messageRaceId = message?.raceId ?? message?.data?.raceId
      return messageRaceId === secondId
    }) as any[]
    expect(new Set(scopedMessages.map((message) => message.type))).toEqual(
      new Set([
        'race:info',
        'race:start',
        'race:tick',
        'race:winner-declared',
        'race:finish',
      ]),
    )
    expect(
      scopedMessages.every(
        (message) => (message.raceId ?? message.data?.raceId) === secondId,
      ),
    ).toBe(true)

    const publicKeys = collectKeys(scopedMessages)
    for (const privateKey of PRIVATE_KEYS) {
      expect(publicKeys.has(privateKey)).toBe(false)
    }
    const serializedMessages = JSON.stringify(scopedMessages)
    expect(serializedMessages).not.toContain(privateSeed)
    expect(serializedMessages).not.toContain(second.config.seed)
    expect(serializedMessages).not.toContain(
      hashStringToInt(second.config.seed).toString(10),
    )
    expect(serializedMessages).not.toContain(
      hashStringToInt(second.config.seed).toString(16),
    )

    expect(upsertSpy).toHaveBeenCalledWith(
      expect.objectContaining({ raceId: secondId, seed: second.config.seed }),
    )
    const secondUpsert = upsertSpy.mock.calls.find(
      ([input]) => input.raceId === secondId,
    )?.[0]
    expect(secondUpsert?.config).not.toHaveProperty('seed')
    expect(startSpy).toHaveBeenCalledWith(secondId, startTime)
    expect(finishSpy).toHaveBeenCalledWith(
      expect.objectContaining({ raceId: secondId }),
    )

    const ordinaryLogs = JSON.stringify(logSpy.mock.calls)
    expect(ordinaryLogs).not.toContain(privateSeed)
    expect(ordinaryLogs).not.toContain(second.config.seed)
  })
})
