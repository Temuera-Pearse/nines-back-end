import express from 'express'
import request from 'supertest'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'

const { raceReadServiceMock } = vi.hoisted(() => ({
  raceReadServiceMock: {
    getCurrentRaceSummary: vi.fn(async () => null),
    getPreviousRaceSummary: vi.fn(async () => null),
    getRaceHistory: vi.fn(async () => []),
    getRaceResults: vi.fn(async () => null),
    getTimeline: vi.fn(async () => null),
    getFinalTicks: vi.fn(async () => null),
    getRawTicks: vi.fn(async () => null),
  } as any,
}))

// ESM mocking: mock signer before importing routes
vi.mock('../utils/signer.js', () => {
  return {
    getPublicKey: () => 'TEST_PUBLIC_KEY_PEM',
    getPublicKeyId: () => 'test-key-id',
  }
})

vi.mock('../services/raceReadService.js', () => {
  return {
    getRaceReadService: () => raceReadServiceMock,
  }
})

import raceRoutes from './raceRoutes.js'
import { RaceState } from '../race/raceState.js'

type EnvSnapshot = NodeJS.ProcessEnv

function makeApp() {
  const app = express()
  app.use('/race', raceRoutes)
  return app
}

let savedEnv: EnvSnapshot

beforeEach(() => {
  savedEnv = { ...process.env }
  process.env.REQUIRE_API_TOKEN = '0'
  delete process.env.API_TOKEN
  raceReadServiceMock.getCurrentRaceSummary.mockResolvedValue(null)
  raceReadServiceMock.getPreviousRaceSummary.mockResolvedValue(null)
  raceReadServiceMock.getRaceHistory.mockResolvedValue([])
  raceReadServiceMock.getRaceResults.mockResolvedValue(null)
  raceReadServiceMock.getTimeline.mockResolvedValue(null)
  raceReadServiceMock.getFinalTicks.mockResolvedValue(null)
  raceReadServiceMock.getRawTicks.mockResolvedValue(null)
})

afterEach(() => {
  process.env = savedEnv
  vi.restoreAllMocks()
})

describe('raceRoutes requireApiToken', () => {
  it('allows requests when REQUIRE_API_TOKEN is not enabled', async () => {
    vi.spyOn(RaceState, 'getHistory').mockReturnValue([] as any)
    const res = await request(makeApp()).get('/race/history')
    expect(res.status).toBe(200)
    expect(res.body).toEqual([])
  })

  it('rejects requests without token when REQUIRE_API_TOKEN=1', async () => {
    process.env.REQUIRE_API_TOKEN = '1'
    process.env.API_TOKEN = 'secret'

    vi.spyOn(RaceState, 'getHistory').mockReturnValue([] as any)

    const res = await request(makeApp()).get('/race/history')
    expect(res.status).toBe(401)
    expect(res.body).toEqual({ error: 'unauthorized' })
  })

  it('accepts token via x-api-token header', async () => {
    process.env.REQUIRE_API_TOKEN = '1'
    process.env.API_TOKEN = 'secret'

    vi.spyOn(RaceState, 'getHistory').mockReturnValue([{ id: 'r1' }] as any)

    const res = await request(makeApp())
      .get('/race/history')
      .set('x-api-token', 'secret')

    expect(res.status).toBe(200)
    expect(res.body).toEqual([{ raceId: 'r1' }])
  })

  it('accepts token via query param', async () => {
    process.env.REQUIRE_API_TOKEN = '1'
    process.env.API_TOKEN = 'secret'

    vi.spyOn(RaceState, 'getHistory').mockReturnValue([{ id: 'r1' }] as any)

    const res = await request(makeApp()).get('/race/history?token=secret')

    expect(res.status).toBe(200)
    expect(res.body).toEqual([{ raceId: 'r1' }])
  })
})

describe('raceRoutes endpoints', () => {
  it('GET /race/current returns 404 when no precomputed race', async () => {
    vi.spyOn(RaceState, 'getPrecomputedRace').mockReturnValue(null)
    const res = await request(makeApp()).get('/race/current')
    expect(res.status).toBe(404)
    expect(res.body).toEqual({ error: 'No race seeded' })
  })

  it('GET /race/current returns race summary', async () => {
    vi.spyOn(RaceState, 'getPrecomputedRace').mockReturnValue({
      id: 'race-1',
      config: { seed: 's', dtMs: 50 },
      finishLine: 123,
      startTime: 1000,
      endTime: 2000,
    } as any)

    const res = await request(makeApp()).get('/race/current')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      raceId: 'race-1',
      config: { dtMs: 50 },
      finishLine: 123,
      startTime: 1000,
      endTime: 2000,
    })
  })

  it('GET /race/current falls back to read service when memory is empty', async () => {
    vi.spyOn(RaceState, 'getPrecomputedRace').mockReturnValue(null)
    raceReadServiceMock.getCurrentRaceSummary.mockResolvedValue({
      raceId: 'race-db-1',
      config: { seed: 'db-seed', durationMs: 20000 },
      finishLine: 1000,
      startTime: '2026-03-16T00:00:30.000Z',
      endTime: '2026-03-16T00:00:50.000Z',
    })

    const res = await request(makeApp()).get('/race/current')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      raceId: 'race-db-1',
      config: { durationMs: 20000 },
      finishLine: 1000,
      startTime: '2026-03-16T00:00:30.000Z',
      endTime: '2026-03-16T00:00:50.000Z',
    })
  })

  it('GET /race/timeline/:raceId rejects the active race artifact before race completion', async () => {
    vi.spyOn(RaceState, 'getPrecomputedRace').mockReturnValue({
      id: 'race-live-1',
    } as any)
    vi.spyOn(RaceState, 'getStateMachine').mockReturnValue({
      getPhaseAndSecond: () => ({ phase: 'countdown', second: 9 }),
    } as any)

    const res = await request(makeApp()).get('/race/timeline/race-live-1')

    expect(res.status).toBe(403)
    expect(res.body).toEqual({
      error: 'race artifact unavailable until race completion',
    })
  })

  it('GET /race/timeline/:raceId allows historical races during countdown', async () => {
    vi.spyOn(RaceState, 'getPrecomputedRace').mockReturnValue({
      id: 'race-live-1',
    } as any)
    vi.spyOn(RaceState, 'getStateMachine').mockReturnValue({
      getPhaseAndSecond: () => ({ phase: 'countdown', second: 9 }),
    } as any)
    raceReadServiceMock.getTimeline.mockResolvedValue([
      { tick: 1, events: [{ id: 'db-event', instanceId: 'evt-1' }] },
    ])

    const res = await request(makeApp()).get('/race/timeline/race-db-4')

    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      timeline: [
        { tick: 1, events: [{ id: 'db-event', instanceId: 'evt-1' }] },
      ],
    })
  })

  it('GET /race/ticks/:raceId returns 404 if race missing', async () => {
    vi.spyOn(RaceState, 'findPrecomputedById').mockReturnValue(null)
    const res = await request(makeApp()).get('/race/ticks/nope')
    expect(res.status).toBe(404)
    expect(res.body).toEqual({ error: 'Race not found' })
  })

  it('GET /race/ticks/:raceId falls back to stored raw ticks when available', async () => {
    vi.spyOn(RaceState, 'findPrecomputedById').mockReturnValue(null)
    raceReadServiceMock.getRawTicks.mockResolvedValue([
      { timestampOffsetMs: 0, positions: [] },
    ])

    const res = await request(makeApp()).get('/race/ticks/race-db-2')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      ticks: [{ timestampOffsetMs: 0, positions: [] }],
    })
  })

  it('GET /race/ticks-final/:raceId returns canonical positions', async () => {
    vi.spyOn(RaceState, 'findPrecomputedById').mockReturnValue({
      id: 'race-2',
      finalHorseStateMatrix: [
        [{ position: 1 }, { position: 2 }],
        [{ position: 3 }, { position: 4 }],
      ],
    } as any)

    const res = await request(makeApp()).get('/race/ticks-final/race-2')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      ticksFinal: [
        { tickIndex: 0, positions: [1, 2] },
        { tickIndex: 1, positions: [3, 4] },
      ],
    })
  })

  it('GET /race/ticks-final/:raceId falls back to stored artifact', async () => {
    vi.spyOn(RaceState, 'findPrecomputedById').mockReturnValue(null)
    raceReadServiceMock.getFinalTicks.mockResolvedValue([
      { tickIndex: 0, positions: [10, 20] },
      { tickIndex: 1, positions: [30, 40] },
    ])

    const res = await request(makeApp()).get('/race/ticks-final/race-db-3')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      ticksFinal: [
        { tickIndex: 0, positions: [10, 20] },
        { tickIndex: 1, positions: [30, 40] },
      ],
    })
  })

  it('GET /race/timeline/:raceId returns compact event timeline sorted by tick', async () => {
    const eventTimeline = new Map<number, any[]>([
      [2, [{ id: 'e2', instanceId: 'i2' }]],
      [
        0,
        [
          { id: 'e0a', instanceId: 'i0a' },
          { id: 'e0b', instanceId: 'i0b' },
        ],
      ],
    ])

    vi.spyOn(RaceState, 'findPrecomputedById').mockReturnValue({
      id: 'race-3',
      eventTimeline,
    } as any)

    const res = await request(makeApp()).get('/race/timeline/race-3')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      timeline: [
        {
          tick: 0,
          events: [
            { id: 'e0a', instanceId: 'i0a' },
            { id: 'e0b', instanceId: 'i0b' },
          ],
        },
        { tick: 2, events: [{ id: 'e2', instanceId: 'i2' }] },
      ],
    })
  })

  it('GET /race/timeline/:raceId falls back to stored artifact', async () => {
    vi.spyOn(RaceState, 'findPrecomputedById').mockReturnValue(null)
    raceReadServiceMock.getTimeline.mockResolvedValue([
      { tick: 1, events: [{ id: 'db-event', instanceId: 'evt-1' }] },
    ])

    const res = await request(makeApp()).get('/race/timeline/race-db-4')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      timeline: [
        { tick: 1, events: [{ id: 'db-event', instanceId: 'evt-1' }] },
      ],
    })
  })

  it('GET /race/results/:raceId returns outcome info', async () => {
    vi.spyOn(RaceState, 'findPrecomputedById').mockReturnValue({
      id: 'race-4',
      authoritativeFinish: {
        raceId: 'race-4',
        timestampUtc: '2026-03-31T12:00:20.000Z',
        winnerId: 'h1',
        finishOrder: ['h1', 'h2'],
        finishTimesMs: { h1: 100, h2: 120 },
        finishTickIndex: { h1: 2, h2: 3 },
        presentation: {
          bannerVisibleUntilUtc: '2026-03-31T12:00:23.400Z',
          resultsVisibleUntilUtc: '2026-03-31T12:00:32.000Z',
        },
      },
      winnerId: 'h1',
      finishOrder: ['h1', 'h2'],
      finishTimesMs: { h1: 100, h2: 120 },
    } as any)

    const res = await request(makeApp()).get('/race/results/race-4')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      raceId: 'race-4',
      timestampUtc: '2026-03-31T12:00:20.000Z',
      winnerId: 'h1',
      finishOrder: ['h1', 'h2'],
      finishTimesMs: { h1: 100, h2: 120 },
      finishTickIndex: { h1: 2, h2: 3 },
      presentation: {
        bannerVisibleUntilUtc: '2026-03-31T12:00:23.400Z',
        resultsVisibleUntilUtc: '2026-03-31T12:00:32.000Z',
      },
      winner: 'h1',
      placements: ['h1', 'h2'],
    })
  })

  it('GET /race/results/:raceId falls back to read service when memory is empty', async () => {
    vi.spyOn(RaceState, 'findPrecomputedById').mockReturnValue(null)
    raceReadServiceMock.getRaceResults.mockResolvedValue({
      raceId: 'race-db-5',
      timestampUtc: '2026-03-31T12:00:20.000Z',
      winnerId: 'horse-2',
      finishOrder: ['horse-2', 'horse-5'],
      finishTimesMs: { 'horse-2': 90, 'horse-5': 110 },
      finishTickIndex: { 'horse-2': 1, 'horse-5': 2 },
      presentation: {
        bannerVisibleUntilUtc: '2026-03-31T12:00:23.400Z',
        resultsVisibleUntilUtc: '2026-03-31T12:00:32.000Z',
      },
      winner: 'horse-2',
      placements: ['horse-2', 'horse-5'],
    })

    const res = await request(makeApp()).get('/race/results/race-db-5')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      raceId: 'race-db-5',
      timestampUtc: '2026-03-31T12:00:20.000Z',
      winnerId: 'horse-2',
      finishOrder: ['horse-2', 'horse-5'],
      finishTimesMs: { 'horse-2': 90, 'horse-5': 110 },
      finishTickIndex: { 'horse-2': 1, 'horse-5': 2 },
      presentation: {
        bannerVisibleUntilUtc: '2026-03-31T12:00:23.400Z',
        resultsVisibleUntilUtc: '2026-03-31T12:00:32.000Z',
      },
      winner: 'horse-2',
      placements: ['horse-2', 'horse-5'],
    })
  })

  it('GET /race/history falls back to read service when memory history is empty', async () => {
    vi.spyOn(RaceState, 'getHistory').mockReturnValue([] as any)
    raceReadServiceMock.getRaceHistory.mockResolvedValue([
      { raceId: 'race-db-6', winnerId: 'horse-1' },
    ])

    const res = await request(makeApp()).get('/race/history')
    expect(res.status).toBe(200)
    expect(res.body).toEqual([
      {
        raceId: 'race-db-6',
        winnerId: 'horse-1',
        finishOrder: [],
        finishTimesMs: {},
      },
    ])
  })

  it('GET /race/previous falls back to read service when memory is empty', async () => {
    vi.spyOn(RaceState, 'getPreviousRace').mockReturnValue(null)
    raceReadServiceMock.getPreviousRaceSummary.mockResolvedValue({
      raceId: 'race-db-7',
      winnerId: 'horse-9',
    })

    const res = await request(makeApp()).get('/race/previous')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      raceId: 'race-db-7',
      winnerId: 'horse-9',
      finishOrder: [],
      finishTimesMs: {},
    })
  })

  it('GET /race/config returns public broadcast config', async () => {
    process.env.KEYFRAME_INTERVAL_TICKS = '25'
    process.env.WS_PING_INTERVAL_MS = '12345'
    process.env.WS_BACKPRESSURE_THRESHOLD = '999'

    const res = await request(makeApp()).get('/race/config')
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      keyId: 'test-key-id',
      publicKey: 'TEST_PUBLIC_KEY_PEM',
      keyframeIntervalTicks: 25,
      wsPingIntervalMs: 12345,
      wsBackpressureThreshold: 999,
      supportsBinary: true,
      supportsDelta: true,
    })
  })
})
