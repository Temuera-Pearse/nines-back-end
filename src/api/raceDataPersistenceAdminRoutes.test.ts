import express from 'express'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import raceDataPersistenceAdminRoutes from './raceDataPersistenceAdminRoutes.js'
import { resetRaceDataPersistencePolicyForTests } from '../persistence/raceDataPersistencePolicy.js'

type EnvSnapshot = NodeJS.ProcessEnv

function makeApp() {
  const app = express()
  app.use(express.json())
  app.use('/admin', raceDataPersistenceAdminRoutes)
  return app
}

let savedEnv: EnvSnapshot

beforeEach(() => {
  savedEnv = { ...process.env }
  process.env.NODE_ENV = 'test'
  delete process.env.NINES_RACE_DATA_PERSISTENCE_ENABLED
  delete process.env.NINES_RACE_DATA_PERSISTENCE_ADMIN_TOKEN
  delete process.env.NINES_ADMIN_TOKEN
  delete process.env.NINES_INTERNAL_RACE_AUTHORITY_TOKEN
  delete process.env.NINES_ADMIN_CORS_ORIGINS
  resetRaceDataPersistencePolicyForTests()
})

afterEach(() => {
  process.env = savedEnv
  resetRaceDataPersistencePolicyForTests()
  vi.restoreAllMocks()
})

describe('raceDataPersistenceAdminRoutes', () => {
  it('returns admin-compatible backend health without persistence access', async () => {
    process.env.NINES_SIMULATION_MODE = 'true'
    process.env.NINES_RACE_DATA_PERSISTENCE_ENABLED = 'false'
    process.env.NINES_RACE_DATA_PERSISTENCE_ADMIN_TOKEN = 'secret'

    const res = await request(makeApp())
      .get('/admin/health')
      .set('Origin', 'http://localhost:5173')

    expect(res.status).toBe(200)
    expect(res.headers['access-control-allow-origin']).toBe(
      'http://localhost:5173',
    )
    expect(res.body).toMatchObject({
      status: 'healthy',
      service: 'nines-back-end',
    })
    expect(new Date(res.body.timestamp).toString()).not.toBe('Invalid Date')
  })

  it('handles admin health CORS preflight for local admin dev', async () => {
    const res = await request(makeApp())
      .options('/admin/health')
      .set('Origin', 'http://127.0.0.1:5173')
      .set('Access-Control-Request-Method', 'GET')
      .set('Access-Control-Request-Headers', 'content-type,authorization')

    expect(res.status).toBe(204)
    expect(res.headers['access-control-allow-origin']).toBe(
      'http://127.0.0.1:5173',
    )
    expect(res.headers['access-control-allow-methods']).toContain('GET')
    expect(res.headers['access-control-allow-headers']).toContain(
      'Authorization',
    )
    expect(res.headers['access-control-allow-headers']).toContain('x-api-token')
  })

  it('returns race authority overview through the browser-safe admin alias', async () => {
    process.env.NINES_SIMULATION_MODE = 'true'
    process.env.NINES_RACE_DATA_PERSISTENCE_ENABLED = 'false'

    const res = await request(makeApp())
      .get('/admin/race/overview')
      .set('Origin', 'http://localhost:5174')

    const serialized = JSON.stringify(res.body)
    expect(res.status).toBe(200)
    expect(res.headers['access-control-allow-origin']).toBe(
      'http://localhost:5174',
    )
    expect(res.body.server.serviceName).toBe('nines-back-end')
    expect(res.body.lifecycle).toBeTruthy()
    expect(res.body.tickHealth).toBeTruthy()
    expect(serialized).not.toContain('seedInt')
    expect(serialized).not.toContain('"seed"')
    expect(serialized).not.toContain('finalHorseStateMatrix')
    expect(serialized).not.toContain('eventTimeline')
    expect(serialized).not.toContain('"ticks"')
  })

  it('handles admin race overview CORS preflight for local admin dev', async () => {
    const res = await request(makeApp())
      .options('/admin/race/overview')
      .set('Origin', 'http://127.0.0.1:5174')
      .set('Access-Control-Request-Method', 'GET')
      .set('Access-Control-Request-Headers', 'content-type,x-api-token')

    expect(res.status).toBe(204)
    expect(res.headers['access-control-allow-origin']).toBe(
      'http://127.0.0.1:5174',
    )
    expect(res.headers['access-control-allow-methods']).toContain('GET')
    expect(res.headers['access-control-allow-headers']).toContain('x-api-token')
  })

  it('returns the default disabled policy', async () => {
    const res = await request(makeApp()).get('/admin/race-data-persistence')

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      enabled: false,
      envDefaultEnabled: false,
      source: 'env_default',
    })
  })

  it('requires bearer token when admin token is configured', async () => {
    process.env.NINES_RACE_DATA_PERSISTENCE_ADMIN_TOKEN = 'secret'

    const unauthorized = await request(makeApp()).get(
      '/admin/race-data-persistence',
    )
    const authorized = await request(makeApp())
      .get('/admin/race-data-persistence')
      .set('Authorization', 'Bearer secret')

    expect(unauthorized.status).toBe(401)
    expect(authorized.status).toBe(200)
  })

  it('updates policy and logs audit output', async () => {
    const warnSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    const res = await request(makeApp())
      .post('/admin/race-data-persistence')
      .send({ enabled: true, reason: 'maintenance window complete' })

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      enabled: true,
      source: 'runtime_override',
      reason: 'maintenance window complete',
      updatedBy: 'admin_endpoint',
    })
    expect(warnSpy.mock.calls.flat().join(' ')).toContain(
      'race-data-persistence:policy-changed',
    )
  })

  it('rejects malformed POST bodies', async () => {
    const res = await request(makeApp())
      .post('/admin/race-data-persistence')
      .send({ enabled: 'true' })

    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: 'enabled boolean is required' })
  })
})
