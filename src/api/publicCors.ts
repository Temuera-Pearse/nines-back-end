import type { RequestHandler } from 'express'

const LOCAL_PUBLIC_ORIGINS = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
]

export function getPublicCorsOrigins(
  env: NodeJS.ProcessEnv = process.env,
): Set<string> {
  const configured = (
    env.NINES_PUBLIC_CORS_ORIGINS ??
    env.CORS_ORIGIN ??
    ''
  )
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean)

  return new Set([...LOCAL_PUBLIC_ORIGINS, ...configured])
}

export function createPublicCorsMiddleware(
  env: NodeJS.ProcessEnv = process.env,
): RequestHandler {
  const allowedOrigins = getPublicCorsOrigins(env)

  return (req, res, next) => {
    if (req.path !== '/health' && !req.path.startsWith('/race/')) {
      return next()
    }

    const origin = req.header('origin')
    if (origin && allowedOrigins.has(origin)) {
      res.setHeader('Vary', 'Origin')
      res.setHeader('Access-Control-Allow-Origin', origin)
      res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
      res.setHeader(
        'Access-Control-Allow-Headers',
        'Accept, Authorization, Content-Type, x-api-token',
      )
      res.setHeader('Access-Control-Max-Age', '600')
    }

    if (req.method === 'OPTIONS') {
      return res.status(204).send()
    }

    return next()
  }
}
