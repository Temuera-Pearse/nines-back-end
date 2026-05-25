import { Router } from 'express'
import type { Request, Response, NextFunction } from 'express'
import { getRaceAuthoritySummary } from '../observability/raceAuthoritySummary.js'

function isInternalEndpointEnabled(): boolean {
  return process.env.NINES_ENABLE_INTERNAL_RACE_AUTHORITY === '1'
}

function bearerToken(req: Request): string | null {
  const header = req.headers.authorization
  if (!header) return null
  const [scheme, token] = header.split(' ')
  if (scheme?.toLowerCase() !== 'bearer' || !token) return null
  return token
}

function requireInternalAccess(req: Request, res: Response, next: NextFunction) {
  if (!isInternalEndpointEnabled()) {
    return res.status(404).json({ error: 'not_found' })
  }

  const expectedToken = process.env.NINES_INTERNAL_RACE_AUTHORITY_TOKEN
  if (expectedToken) {
    const token = bearerToken(req) ?? String(req.headers['x-internal-token'] ?? '')
    if (token === expectedToken) return next()
    return res.status(401).json({ error: 'unauthorized' })
  }

  if (process.env.NODE_ENV === 'production') {
    return res.status(403).json({ error: 'internal token required' })
  }

  return next()
}

const router = Router()

router.get('/summary', requireInternalAccess, async (_req, res) => {
  try {
    res.json(await getRaceAuthoritySummary())
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    res.status(500).json({ error: 'race authority summary unavailable', message })
  }
})

export default router
