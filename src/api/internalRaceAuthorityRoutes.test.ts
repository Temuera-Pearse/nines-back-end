import express from 'express'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import internalRaceAuthorityRoutes from './internalRaceAuthorityRoutes.js'

type EnvSnapshot = NodeJS.ProcessEnv

function makeApp() {
  const app = express()
  app.use('/internal/race-authority', internalRaceAuthorityRoutes)
  return app
}

let savedEnv: EnvSnapshot

beforeEach(() => {
  savedEnv = { ...process.env }
  process.env.NODE_ENV = 'test'
  delete process.env.NINES_ENABLE_INTERNAL_RACE_AUTHORITY
  delete process.env.NINES_INTERNAL_RACE_AUTHORITY_TOKEN
  delete process.env.DATABASE_URL
})

afterEach(() => {
  process.env = savedEnv
})

describe('internalRaceAuthorityRoutes', () => {
  it('hides the summary endpoint unless explicitly enabled', async () => {
    const res = await request(makeApp()).get('/internal/race-authority/summary')

    expect(res.status).toBe(404)
    expect(res.body).toEqual({ error: 'not_found' })
  })

  it('requires the configured internal bearer token', async () => {
    process.env.NINES_ENABLE_INTERNAL_RACE_AUTHORITY = '1'
    process.env.NINES_INTERNAL_RACE_AUTHORITY_TOKEN = 'secret'

    const unauthorized = await request(makeApp()).get(
      '/internal/race-authority/summary',
    )
    const authorized = await request(makeApp())
      .get('/internal/race-authority/summary')
      .set('Authorization', 'Bearer secret')

    expect(unauthorized.status).toBe(401)
    expect(authorized.status).toBe(200)
    expect(authorized.body.server.serviceName).toBe('nines-back-end')
  })

  it('returns a safe summary without deterministic outcome fields', async () => {
    process.env.NINES_ENABLE_INTERNAL_RACE_AUTHORITY = '1'

    const res = await request(makeApp()).get('/internal/race-authority/summary')
    const serialized = JSON.stringify(res.body)

    expect(res.status).toBe(200)
    expect(res.body.lifecycle).toBeTruthy()
    expect(res.body.tickHealth).toBeTruthy()
    expect(serialized).not.toContain('seedInt')
    expect(serialized).not.toContain('"seed"')
    expect(serialized).not.toContain('finalHorseStateMatrix')
    expect(serialized).not.toContain('eventTimeline')
    expect(serialized).not.toContain('"ticks"')
  })
})
