import { Router } from 'express'
import type { NextFunction, Request, Response } from 'express'
import {
  getRaceDataPersistencePolicy,
  setRaceDataPersistenceEnabled,
} from '../persistence/raceDataPersistencePolicy.js'

function bearerToken(req: Request): string | null {
  const header = req.headers.authorization
  if (!header) return null
  const [scheme, token] = header.split(' ')
  if (scheme?.toLowerCase() !== 'bearer' || !token) return null
  return token
}

function expectedAdminToken(): string {
  return (
    process.env.NINES_RACE_DATA_PERSISTENCE_ADMIN_TOKEN ||
    process.env.NINES_ADMIN_TOKEN ||
    process.env.NINES_INTERNAL_RACE_AUTHORITY_TOKEN ||
    ''
  )
}

function requireAdminAccess(req: Request, res: Response, next: NextFunction) {
  const expected = expectedAdminToken()
  if (expected) {
    const token = bearerToken(req) ?? String(req.headers['x-admin-token'] ?? '')
    if (token === expected) return next()
    return res.status(401).json({ error: 'unauthorized' })
  }

  if (process.env.NODE_ENV === 'production') {
    return res.status(403).json({ error: 'admin token required' })
  }

  return next()
}

const router = Router()

router.get('/race-data-persistence', requireAdminAccess, (_req, res) => {
  res.json(getRaceDataPersistencePolicy())
})

router.post('/race-data-persistence', requireAdminAccess, (req, res) => {
  const enabled = req.body?.enabled
  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ error: 'enabled boolean is required' })
  }

  const reason =
    typeof req.body?.reason === 'string' ? req.body.reason : undefined
  res.json(
    setRaceDataPersistenceEnabled({
      enabled,
      reason,
      updatedBy: 'admin_endpoint',
    }),
  )
})

export default router
