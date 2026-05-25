import { Pool } from 'pg'
import { isRaceDataPersistenceEnabled } from '../persistence/raceDataPersistencePolicy.js'

let pool: Pool | null = null

export function isDatabaseConfigured(): boolean {
  if (!isRaceDataPersistenceEnabled()) return false
  return Boolean(process.env.DATABASE_URL)
}

export function initPool(): Pool | null {
  if (pool) return pool
  if (!isDatabaseConfigured()) return null

  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
  })
  return pool
}

export function getPool(): Pool {
  const next = initPool()
  if (!next) {
    throw new Error('DATABASE_URL is not configured')
  }
  return next
}

export function getOptionalPool(): Pool | null {
  return initPool()
}

export async function verifyPool(): Promise<void> {
  if (!isRaceDataPersistenceEnabled()) return
  const next = initPool()
  if (!next) return
  await next.query('select 1')
}

export async function closePool(): Promise<void> {
  if (!pool) return
  await pool.end()
  pool = null
}
