import { Router } from 'express'
import { RaceState } from '../race/raceState.js'
import type { EventInstance } from '../race/events/timeline.js'
import { getPublicKey, getPublicKeyId } from '../utils/signer.js'
import type { Request, Response, NextFunction } from 'express'

function requireApiToken(req: Request, res: Response, next: NextFunction) {
  if (process.env.REQUIRE_API_TOKEN !== '1') return next()
  const expected = process.env.API_TOKEN || ''
  const tok = req.headers['x-api-token'] || req.query['token']
  if (typeof tok === 'string' && tok === expected) return next()
  return res.status(401).json({ error: 'unauthorized' })
}

const router = Router()

/**
 * GET /race/current - Get the currently running race
 */
router.get('/current', requireApiToken, (req, res) => {
  const pre = RaceState.getPrecomputedRace()
  if (!pre) return res.status(404).json({ error: 'No race seeded' })
  res.json({
    raceId: pre.id,
    config: pre.config,
    finishLine: pre.finishLine,
    startTime: pre.startTime,
    endTime: pre.endTime,
  })
})

/**
 * GET /race/previous - Get the last completed race
 */
router.get('/previous', requireApiToken, (req, res) => {
  const race = RaceState.getPreviousRace()
  res.json(race)
})

/**
 * GET /race/history - Get race history (last 20 races)
 */
router.get('/history', requireApiToken, (req, res) => {
  const history = RaceState.getHistory() // fixed
  res.json(history)
})

router.get('/ticks/:raceId', requireApiToken, (req, res) => {
  const { raceId } = req.params
  const pre = RaceState.findPrecomputedById(raceId)
  if (!pre) return res.status(404).json({ error: 'Race not found' })
  res.json({ ticks: pre.ticks })
})

/**
 * GET /race/ticks-final/:raceId - Canonical positions per tick from final matrix
 */
router.get('/ticks-final/:raceId', requireApiToken, (req, res) => {
  const { raceId } = req.params
  const pre = RaceState.findPrecomputedById(raceId)
  if (!pre || !pre.finalHorseStateMatrix)
    return res.status(404).json({ error: 'Race not found' })

  const out = pre.finalHorseStateMatrix.map((states, i) => ({
    tickIndex: i,
    positions: states.map((s) => s.position),
  }))
  res.json({ ticksFinal: out })
})

/**
 * GET /race/timeline/:raceId - Compact event timeline
 */
router.get('/timeline/:raceId', requireApiToken, (req, res) => {
  const { raceId } = req.params
  const pre = RaceState.findPrecomputedById(raceId)
  if (!pre || !pre.eventTimeline)
    return res.status(404).json({ error: 'Race not found' })

  const out: Array<{
    tick: number
    events: Array<Pick<EventInstance, 'id' | 'instanceId'>>
  }> = []
  for (const [tickIndex, events] of pre.eventTimeline.entries()) {
    out.push({
      tick: tickIndex,
      events: events.map((e) => ({ id: e.id, instanceId: e.instanceId })),
    })
  }
  out.sort((a, b) => a.tick - b.tick)
  res.json({ timeline: out })
})

router.get('/results/:raceId', requireApiToken, (req, res) => {
  const { raceId } = req.params
  const pre = RaceState.findPrecomputedById(raceId)
  if (!pre) return res.status(404).json({ error: 'Race not found' })
  res.json({
    winnerId: pre.winnerId,
    finishOrder: pre.finishOrder,
    finishTimesMs: pre.finishTimesMs,
  })
})

/**
 * GET /race/config - Public broadcast config for clients
 */
router.get('/config', requireApiToken, (req, res) => {
  try {
    const pubKey = getPublicKey()
    const keyId = getPublicKeyId()
    res.json({
      keyId,
      publicKey: pubKey,
      keyframeIntervalTicks: Number(process.env.KEYFRAME_INTERVAL_TICKS || 20),
      wsPingIntervalMs: Number(process.env.WS_PING_INTERVAL_MS || 30000),
      wsBackpressureThreshold: Number(
        process.env.WS_BACKPRESSURE_THRESHOLD || 1000000,
      ),
      supportsBinary: true,
      supportsDelta: true,
    })
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? String(e) })
  }
})

export default router
