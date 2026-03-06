import express from 'express'
import request from 'supertest'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'

// ESM mocking: mock signer before importing routes
vi.mock('../utils/signer.js', () => {
  return {
    getPublicKey: () => 'TEST_PUBLIC_KEY_PEM',
    getPublicKeyId: () => 'test-key-id',
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
    expect(res.body).toEqual([{ id: 'r1' }])
  })

  it('accepts token via query param', async () => {
    process.env.REQUIRE_API_TOKEN = '1'
    process.env.API_TOKEN = 'secret'

    vi.spyOn(RaceState, 'getHistory').mockReturnValue([{ id: 'r1' }] as any)

    const res = await request(makeApp()).get('/race/history?token=secret')

    expect(res.status).toBe(200)
    expect(res.body).toEqual([{ id: 'r1' }])
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
      config: { seed: 's' },
      finishLine: 123,
      startTime: 1000,
      endTime: 2000,
    } as any)

    const res = await request(makeApp()).get('/race/current')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      raceId: 'race-1',
      config: { seed: 's' },
      finishLine: 123,
      startTime: 1000,
      endTime: 2000,
    })
  })

  it('GET /race/ticks/:raceId returns 404 if race missing', async () => {
    vi.spyOn(RaceState, 'findPrecomputedById').mockReturnValue(null)
    const res = await request(makeApp()).get('/race/ticks/nope')
    expect(res.status).toBe(404)
    expect(res.body).toEqual({ error: 'Race not found' })
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

  it('GET /race/results/:raceId returns outcome info', async () => {
    vi.spyOn(RaceState, 'findPrecomputedById').mockReturnValue({
      id: 'race-4',
      winnerId: 'h1',
      finishOrder: ['h1', 'h2'],
      finishTimesMs: { h1: 100, h2: 120 },
    } as any)

    const res = await request(makeApp()).get('/race/results/race-4')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      winnerId: 'h1',
      finishOrder: ['h1', 'h2'],
      finishTimesMs: { h1: 100, h2: 120 },
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
