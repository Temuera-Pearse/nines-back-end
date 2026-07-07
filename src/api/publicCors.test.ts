import express from 'express'
import request from 'supertest'
import { describe, expect, it } from 'vitest'
import {
  createPublicCorsMiddleware,
  getPublicCorsOrigins,
} from './publicCors.js'

function makeApp(env: NodeJS.ProcessEnv = {}) {
  const app = express()
  app.use(createPublicCorsMiddleware(env))
  app.get('/race/config', (_req, res) => res.json({ ok: true }))
  app.get('/race/current', (_req, res) => res.json({ ok: true }))
  app.get('/admin/health', (_req, res) => res.json({ ok: true }))
  return app
}

describe('public race CORS', () => {
  it('allows both local frontend origins by default', () => {
    expect(getPublicCorsOrigins()).toEqual(
      new Set([
        'http://localhost:5173',
        'http://127.0.0.1:5173',
      ]),
    )
  })

  it.each([
    'http://localhost:5173',
    'http://127.0.0.1:5173',
  ])('allows public race GET requests from %s', async (origin) => {
    const res = await request(makeApp())
      .get('/race/current')
      .set('Origin', origin)

    expect(res.status).toBe(200)
    expect(res.headers['access-control-allow-origin']).toBe(origin)
  })

  it('handles public race preflight headers', async () => {
    const res = await request(makeApp())
      .options('/race/config')
      .set('Origin', 'http://localhost:5173')
      .set('Access-Control-Request-Method', 'GET')
      .set(
        'Access-Control-Request-Headers',
        'authorization,content-type,x-api-token',
      )

    expect(res.status).toBe(204)
    expect(res.headers['access-control-allow-origin']).toBe(
      'http://localhost:5173',
    )
    expect(res.headers['access-control-allow-methods']).toContain('GET')
    expect(res.headers['access-control-allow-headers']).toContain(
      'Authorization',
    )
    expect(res.headers['access-control-allow-headers']).toContain(
      'Content-Type',
    )
    expect(res.headers['access-control-allow-headers']).toContain('x-api-token')
  })

  it('supports additional comma-separated origins', async () => {
    const origin = 'https://frontend.example'
    const res = await request(
      makeApp({
        NINES_PUBLIC_CORS_ORIGINS: `https://one.example, ${origin}`,
      }),
    )
      .get('/race/config')
      .set('Origin', origin)

    expect(res.headers['access-control-allow-origin']).toBe(origin)
  })

  it('does not add public CORS headers to admin routes', async () => {
    const res = await request(makeApp())
      .get('/admin/health')
      .set('Origin', 'http://localhost:5173')

    expect(res.status).toBe(200)
    expect(res.headers['access-control-allow-origin']).toBeUndefined()
  })
})
