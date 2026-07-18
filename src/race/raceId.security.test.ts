import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { getRaceRepository } from '../db/raceRepository.js'
import {
  handleSyncRequest,
  RaceWebSocketServer,
} from '../websocket/wsServer.js'
import { activeRaces } from './activeRaceMemory.js'
import { computeRaceChecksum } from './checksum.js'
import {
  allocateUniqueRaceRef,
  createOpaqueRaceId,
  createRaceRef,
  resetAllocatedRaceRefsForTests,
} from './raceId.js'
import {
  seedPrecomputedRace,
  startPrecomputedRace,
  streamPrecomputedTickAt,
} from './raceEngine.js'
import { hashStringToInt } from './rng.js'
import { RaceState } from './raceState.js'
import type { PrecomputedRace } from './raceTypes.js'

const PRIVATE_KEYS = new Set([
  'raceId',
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
  resetAllocatedRaceRefsForTests()
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

  it('uses a cryptographically random Crockford Base32 public reference', () => {
    expect(createRaceRef()).toMatch(/^N9-[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/)
  })

  it('regenerates a public reference when allocation detects a collision', () => {
    const candidates = [
      'N9-7K3M2-Q8D4X',
      'N9-7K3M2-Q8D4X',
      'N9-9BCDE-FGHJK',
    ]
    const factory = vi.fn(() => candidates.shift()!)

    expect(allocateUniqueRaceRef(factory as any)).toBe('N9-7K3M2-Q8D4X')
    expect(allocateUniqueRaceRef(factory as any)).toBe('N9-9BCDE-FGHJK')
    expect(factory).toHaveBeenCalledTimes(3)
  })

  it('keeps race identity independent and stable through retries and lifecycle', async () => {
    const privateSeed = 'horse-count-test'
    const firstId = 'race-00000000-0000-4000-8000-000000000001'
    const secondId = 'race-00000000-0000-4000-8000-000000000002'
    const firstRef = 'N9-7K3M2-Q8D4X'
    const secondRef = 'N9-9BCDE-FGHJK'
    const firstIdFactory = vi.fn(() => firstId)
    const secondIdFactory = vi.fn(() => secondId)
    const firstRefFactory = vi.fn(() => firstRef)
    const secondRefFactory = vi.fn(() => secondRef)
    const broadcasts: unknown[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(RaceWebSocketServer, 'broadcast').mockImplementation((message) => {
      broadcasts.push(message)
    })
    const repository = getRaceRepository()
    const upsertSpy = vi
      .spyOn(repository, 'upsertSeededRace')
      .mockImplementation(async (input) => input.raceRef)
    const startSpy = vi
      .spyOn(repository, 'markRaceStarted')
      .mockResolvedValue(undefined)
    const finishSpy = vi
      .spyOn(repository, 'markRaceFinished')
      .mockResolvedValue(undefined)

    RaceState.setCurrentSeed(privateSeed)
    const first = seedPrecomputedRace({
      raceId: firstIdFactory as any,
      raceRef: firstRefFactory as any,
    })
    RaceState.setCurrentSeed(privateSeed)
    const second = seedPrecomputedRace({
      raceId: secondIdFactory as any,
      raceRef: secondRefFactory as any,
    })
    await new Promise<void>((resolve) => setImmediate(resolve))

    expect(first.raceId).toBe(firstId)
    expect(second.raceId).toBe(secondId)
    expect(first.raceRef).toBe(firstRef)
    expect(second.raceRef).toBe(secondRef)
    expect(firstIdFactory).toHaveBeenCalledTimes(1)
    expect(secondIdFactory).toHaveBeenCalledTimes(1)
    expect(firstRefFactory).toHaveBeenCalledTimes(1)
    expect(secondRefFactory).toHaveBeenCalledTimes(1)
    expect(first.config.seed).toMatch(`${privateSeed}:finish-retry-`)
    expect(second.config.seed).toBe(first.config.seed)
    expect({ ...publicGenerationArtifacts(second), checksum: undefined }).toEqual({
      ...publicGenerationArtifacts(first),
      checksum: undefined,
    })
    expect(second.checksum).not.toBe(first.checksum)

    for (const internalSeed of [privateSeed, second.config.seed]) {
      const seedInt = hashStringToInt(internalSeed)
      expect(second.raceRef).not.toContain(seedInt.toString(10))
      expect(second.raceRef).not.toContain(seedInt.toString(16))
      expect(second.raceId).not.toContain(seedInt.toString(10))
    }

    const checksumWithoutPrivateMetadata = computeRaceChecksum({
      ...second,
      raceId: 'race-another-private-id',
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
    expect(RaceState.getPrecomputedRace()?.raceRef).toBe(secondRef)
    RaceState.getStateMachine().transition('race_starting')
    const startTime = new Date('2026-07-18T00:00:30.000Z')
    expect(startPrecomputedRace(startTime).raceRef).toBe(secondRef)
    streamPrecomputedTickAt(5)

    const syncFrames: string[] = []
    handleSyncRequest(
      { send: (frame: string) => syncFrames.push(frame) } as any,
      { type: 'sync:request', raceRef: secondRef, fromTick: 0 },
    )
    expect(syncFrames.length).toBeGreaterThan(0)
    expect(syncFrames.map((frame) => JSON.parse(frame))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'race:sync-complete',
          raceRef: secondRef,
        }),
      ]),
    )
    expect(syncFrames.join('')).not.toContain(secondId)

    const rejectedFrames: string[] = []
    handleSyncRequest(
      { send: (frame: string) => rejectedFrames.push(frame) } as any,
      { type: 'sync:request', raceId: secondId },
    )
    expect(rejectedFrames.join('')).toContain('invalid raceRef')
    streamPrecomputedTickAt(second.ticks.length - 1)

    const scopedMessages = broadcasts.filter((message: any) => {
      return message?.raceRef === secondRef
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
        (message) => message.raceRef === secondRef,
      ),
    ).toBe(true)

    const publicKeys = collectKeys(scopedMessages)
    for (const privateKey of PRIVATE_KEYS) {
      expect(publicKeys.has(privateKey)).toBe(false)
    }
    const serializedMessages = JSON.stringify(scopedMessages)
    expect(serializedMessages).not.toContain(privateSeed)
    expect(serializedMessages).not.toContain(second.config.seed)
    expect(serializedMessages).not.toContain(secondId)
    expect(serializedMessages).not.toContain(
      hashStringToInt(second.config.seed).toString(10),
    )
    expect(serializedMessages).not.toContain(
      hashStringToInt(second.config.seed).toString(16),
    )

    expect(upsertSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        raceId: secondId,
        raceRef: secondRef,
        seed: second.config.seed,
      }),
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
    expect(ordinaryLogs).not.toContain(secondId)
  })
})
