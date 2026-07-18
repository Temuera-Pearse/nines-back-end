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

    vi.spyOn(RaceState, 'getHistory').mockReturnValue([{ raceRef: 'r1' }] as any)

    const res = await request(makeApp())
      .get('/race/history')
      .set('x-api-token', 'secret')

    expect(res.status).toBe(200)
    expect(res.body).toEqual([{ raceRef: 'r1' }])
  })

  it('accepts token via query param', async () => {
    process.env.REQUIRE_API_TOKEN = '1'
    process.env.API_TOKEN = 'secret'

    vi.spyOn(RaceState, 'getHistory').mockReturnValue([{ raceRef: 'r1' }] as any)

    const res = await request(makeApp()).get('/race/history?token=secret')

    expect(res.status).toBe(200)
    expect(res.body).toEqual([{ raceRef: 'r1' }])
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
      raceRef: 'race-1',
      config: {
        seed: 's',
        privateSeed: 'defensive-private-seed',
        seedInt: 123,
        dtMs: 50,
      },
      finishLine: 123,
      startTime: 1000,
      endTime: 2000,
    } as any)

    const res = await request(makeApp()).get('/race/current')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      raceRef: 'race-1',
      config: { dtMs: 50 },
      finishLine: 123,
      startTime: 1000,
      endTime: 2000,
    })
  })

  it('GET /race/current falls back to read service when memory is empty', async () => {
    vi.spyOn(RaceState, 'getPrecomputedRace').mockReturnValue(null)
    raceReadServiceMock.getCurrentRaceSummary.mockResolvedValue({
      raceRef: 'race-db-1',
      config: {
        seed: 'db-seed',
        privateSeed: 'defensive-private-db-seed',
        seedInt: 456,
        durationMs: 20000,
      },
      finishLine: 1000,
      startTime: '2026-03-16T00:00:30.000Z',
      endTime: '2026-03-16T00:00:50.000Z',
    })

    const res = await request(makeApp()).get('/race/current')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      raceRef: 'race-db-1',
      config: { durationMs: 20000 },
      finishLine: 1000,
      startTime: '2026-03-16T00:00:30.000Z',
      endTime: '2026-03-16T00:00:50.000Z',
    })
  })

  it('GET /race/timeline/:raceRef rejects the active race artifact before race completion', async () => {
    vi.spyOn(RaceState, 'getPrecomputedRace').mockReturnValue({
      raceRef: 'N9-LVE00-00001',
    } as any)
    vi.spyOn(RaceState, 'getStateMachine').mockReturnValue({
      getPhaseAndSecond: () => ({ phase: 'countdown', second: 9 }),
    } as any)

    const res = await request(makeApp()).get('/race/timeline/N9-LVE00-00001')

    expect(res.status).toBe(403)
    expect(res.body).toEqual({
      error: 'race artifact unavailable until race completion',
    })
  })

  it('GET /race/timeline/:raceRef allows historical races during countdown', async () => {
    vi.spyOn(RaceState, 'getPrecomputedRace').mockReturnValue({
      raceRef: 'N9-LVE00-00001',
    } as any)
    vi.spyOn(RaceState, 'getStateMachine').mockReturnValue({
      getPhaseAndSecond: () => ({ phase: 'countdown', second: 9 }),
    } as any)
    raceReadServiceMock.getTimeline.mockResolvedValue([
      { tick: 1, events: [{ id: 'db-event', instanceId: 'evt-1' }] },
    ])

    const res = await request(makeApp()).get('/race/timeline/N9-DB400-00004')

    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      raceRef: 'N9-DB400-00004',
      timeline: [
        { tick: 1, events: [{ id: 'db-event', instanceId: 'evt-1' }] },
      ],
    })
  })

  it('GET /race/ticks/:raceRef returns 404 if race missing', async () => {
    vi.spyOn(RaceState, 'findPrecomputedByRef').mockReturnValue(null)
    const res = await request(makeApp()).get('/race/ticks/nope')
    expect(res.status).toBe(404)
    expect(res.body).toEqual({ error: 'Race not found' })
  })

  it('GET /race/ticks/:raceRef falls back to stored raw ticks when available', async () => {
    vi.spyOn(RaceState, 'findPrecomputedByRef').mockReturnValue(null)
    raceReadServiceMock.getRawTicks.mockResolvedValue([
      { timestampOffsetMs: 0, positions: [] },
    ])

    const res = await request(makeApp()).get('/race/ticks/N9-DB200-00002')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      raceRef: 'N9-DB200-00002',
      ticks: [{ timestampOffsetMs: 0, positions: [] }],
    })
  })

  it('GET /race/ticks-final/:raceRef returns canonical positions', async () => {
    vi.spyOn(RaceState, 'findPrecomputedByRef').mockReturnValue({
      raceRef: 'N9-RCE20-00002',
      finalHorseStateMatrix: [
        [{ position: 1 }, { position: 2 }],
        [{ position: 3 }, { position: 4 }],
      ],
    } as any)

    const res = await request(makeApp()).get('/race/ticks-final/N9-RCE20-00002')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      raceRef: 'N9-RCE20-00002',
      ticksFinal: [
        { tickIndex: 0, positions: [1, 2] },
        { tickIndex: 1, positions: [3, 4] },
      ],
    })
  })

  it('GET /race/ticks-final/:raceRef falls back to stored artifact', async () => {
    vi.spyOn(RaceState, 'findPrecomputedByRef').mockReturnValue(null)
    raceReadServiceMock.getFinalTicks.mockResolvedValue([
      { tickIndex: 0, positions: [10, 20] },
      { tickIndex: 1, positions: [30, 40] },
    ])

    const res = await request(makeApp()).get('/race/ticks-final/N9-DB300-00003')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      raceRef: 'N9-DB300-00003',
      ticksFinal: [
        { tickIndex: 0, positions: [10, 20] },
        { tickIndex: 1, positions: [30, 40] },
      ],
    })
  })

  it('GET /race/timeline/:raceRef returns compact event timeline sorted by tick', async () => {
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

    vi.spyOn(RaceState, 'findPrecomputedByRef').mockReturnValue({
      raceRef: 'N9-RCE30-00003',
      eventTimeline,
    } as any)

    const res = await request(makeApp()).get('/race/timeline/N9-RCE30-00003')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      raceRef: 'N9-RCE30-00003',
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

  it('GET /race/timeline/:raceRef falls back to stored artifact', async () => {
    vi.spyOn(RaceState, 'findPrecomputedByRef').mockReturnValue(null)
    raceReadServiceMock.getTimeline.mockResolvedValue([
      { tick: 1, events: [{ id: 'db-event', instanceId: 'evt-1' }] },
    ])

    const res = await request(makeApp()).get('/race/timeline/N9-DB400-00004')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      raceRef: 'N9-DB400-00004',
      timeline: [
        { tick: 1, events: [{ id: 'db-event', instanceId: 'evt-1' }] },
      ],
    })
  })

  it('GET /race/results/:raceRef returns outcome info', async () => {
    vi.spyOn(RaceState, 'findPrecomputedByRef').mockReturnValue({
      raceRef: 'N9-RCE40-00004',
      authoritativeFinish: {
        raceRef: 'N9-RCE40-00004',
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

    const res = await request(makeApp()).get('/race/results/N9-RCE40-00004')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      raceRef: 'N9-RCE40-00004',
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

  it('GET /race/results/:raceRef falls back to read service when memory is empty', async () => {
    vi.spyOn(RaceState, 'findPrecomputedByRef').mockReturnValue(null)
    raceReadServiceMock.getRaceResults.mockResolvedValue({
      raceRef: 'N9-DB500-00005',
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

    const res = await request(makeApp()).get('/race/results/N9-DB500-00005')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      raceRef: 'N9-DB500-00005',
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
      { raceRef: 'race-db-6', winnerId: 'horse-1' },
    ])

    const res = await request(makeApp()).get('/race/history')
    expect(res.status).toBe(200)
    expect(res.body).toEqual([
      {
        raceRef: 'race-db-6',
        winnerId: 'horse-1',
        finishOrder: [],
        finishTimesMs: {},
      },
    ])
  })

  it('GET /race/previous falls back to read service when memory is empty', async () => {
    vi.spyOn(RaceState, 'getPreviousRace').mockReturnValue(null)
    raceReadServiceMock.getPreviousRaceSummary.mockResolvedValue({
      raceRef: 'race-db-7',
      winnerId: 'horse-8',
    })

    const res = await request(makeApp()).get('/race/previous')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      raceRef: 'race-db-7',
      winnerId: 'horse-8',
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
