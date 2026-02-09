import type { Request, Response, NextFunction } from 'express'
import { createClient } from 'redis'

type Bucket = { tokens: number; last: number }
const buckets = new Map<string, Bucket>()
let redisClient: ReturnType<typeof createClient> | null = null

async function getRedis(): Promise<ReturnType<typeof createClient> | null> {
  if (redisClient) return redisClient
  try {
    const url = process.env.REDIS_URL || 'redis://localhost:6379'
    const c = createClient({ url })
    await c.connect()
    redisClient = c
    return c
  } catch {
    return null
  }
}

export function rateLimit(opts: { windowMs: number; max: number }) {
  const refillRate = opts.max / (opts.windowMs / 1000)
  const provider = (process.env.RATE_LIMIT_PROVIDER || 'memory').toLowerCase()
  return async function (req: Request, res: Response, next: NextFunction) {
    if (process.env.RATE_LIMIT !== '1') return next()
    const ip = (req.headers['x-forwarded-for'] as string) || req.ip || 'unknown'
    const now = Date.now()
    if (provider === 'redis') {
      const r = await getRedis()
      if (r) {
        const key = `rl:${ip}`
        const ttl = Math.ceil(opts.windowMs / 1000)
        try {
          const val = await r.incr(key)
          if (val === 1) await r.expire(key, ttl)
          if (val > opts.max)
            return res.status(429).json({ error: 'rate_limited' })
          return next()
        } catch {
          // fallback to memory
        }
      }
    }
    let b = buckets.get(ip)
    if (!b) {
      b = { tokens: opts.max, last: now }
      buckets.set(ip, b)
    }
    const elapsed = (now - b.last) / 1000
    b.tokens = Math.min(opts.max, b.tokens + elapsed * refillRate)
    b.last = now
    if (b.tokens >= 1) {
      b.tokens -= 1
      return next()
    }
    res.status(429).json({ error: 'rate_limited' })
  }
}
