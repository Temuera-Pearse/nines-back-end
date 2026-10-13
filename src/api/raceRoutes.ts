import { Router } from 'express'
import { RaceState } from '../race/raceState.js'
import type { EventInstance } from '../race/events/timeline.js'
import { getPublicKey, getPublicKeyId } from '../utils/signer.js'
import type { Request, Response, NextFunction } from 'express'
import { getRaceReadService } from '../services/raceReadService.js'
import type { RaceFinishPayload } from '../race/raceTypes.js'

function requireApiToken(req: Request, res: Response, next: NextFunction) {
  if (process.env.REQUIRE_API_TOKEN !== '1') return next()
  const expected = process.env.API_TOKEN || ''
  const tok = req.headers['x-api-token'] || req.query['token']
  if (typeof tok === 'string' && tok === expected) return next()
  return res.status(401).json({ error: 'unauthorized' })
}

const router = Router()
const raceReadService = getRaceReadService()

function respondWithFinishPayload(
  res: Response,
  payload: Partial<RaceFinishPayload>,
) {
  const finishOrder = Array.isArray(payload.finishOrder)
    ? payload.finishOrder
    : []
  return res.json({
    raceRef: payload.raceRef,
    timestampUtc: payload.timestampUtc,
    winnerId: payload.winnerId,
    finishOrder,
    finishTimesMs: payload.finishTimesMs ?? {},
    finishTickIndex: payload.finishTickIndex ?? {},
    presentation: payload.presentation ?? {
      bannerVisibleUntilUtc: '',
      resultsVisibleUntilUtc: '',
    },
    winner: payload.winnerId,
    placements: [...finishOrder],
  })
}

function sanitizeRaceConfig(config: unknown) {
  if (!config || typeof config !== 'object') return config
  const {
    seed: _seed,
    privateSeed: _privateSeed,
    seedInt: _seedInt,
    ...rest
  } = config as Record<string, unknown>
  return rest
}

function publicRaceSummary(race: {
  raceRef?: string | null
  config?: unknown
  finishLine?: unknown
  startTime?: unknown
  endTime?: unknown
  winnerId?: unknown
  finishOrder?: unknown
  finishTimesMs?: unknown
  checksum?: unknown
  lifecycleStatus?: unknown
  persistenceStatus?: unknown
}) {
  const isComplete = Boolean(race.endTime) || Boolean(race.winnerId)
  const summary: Record<string, unknown> = {
    raceRef: race.raceRef ?? null,
  }

  if (race.config !== undefined) summary.config = sanitizeRaceConfig(race.config)
  if (race.finishLine !== undefined) summary.finishLine = race.finishLine
  if (race.startTime !== undefined) summary.startTime = race.startTime
  if (race.endTime !== undefined) summary.endTime = race.endTime
  if (race.lifecycleStatus !== undefined) {
    summary.lifecycleStatus = race.lifecycleStatus
  }
  if (race.persistenceStatus !== undefined) {
    summary.persistenceStatus = race.persistenceStatus
  }

  if (isComplete) {
    summary.winnerId = race.winnerId
    summary.finishOrder = Array.isArray(race.finishOrder) ? race.finishOrder : []
    summary.finishTimesMs =
      race.finishTimesMs && typeof race.finishTimesMs === 'object'
        ? race.finishTimesMs
        : {}
    if (race.checksum !== undefined) summary.checksum = race.checksum
  }

  return summary
}

function isPublicArtifactAvailable(raceRef: string): boolean {
  const current = RaceState.getPrecomputedRace()
  if (!current || current.raceRef !== raceRef.toUpperCase()) return true
  if (current.endTime || current.authoritativeFinish) return true
  const { phase } = RaceState.getStateMachine().getPhaseAndSecond()
  return phase === 'race_finished' || phase === 'results_showing'
}

function rejectIfArtifactUnavailable(
  raceRef: string,
  res: Response,
): boolean {
  if (isPublicArtifactAvailable(raceRef)) return false
  res
    .status(403)
    .json({ error: 'race artifact unavailable until race completion' })
  return true
}

/**
 * GET /race/current - Get the currently running race
 */
router.get('/current', requireApiToken, async (req, res) => {
  const pre = RaceState.getPrecomputedRace()
  if (pre) {
    return res.json({
      raceRef: pre.raceRef,
      config: sanitizeRaceConfig(pre.config),
      finishLine: pre.finishLine,
      startTime: pre.startTime,
      endTime: pre.endTime,
      phase: RaceState.getStateMachine().getPhaseAndSecond().phase,
      bettingOpensAt: pre.bettingOpensAt,
      bettingClosesAt: pre.bettingClosesAt,
      entrants: pre.horses.map((horse) => ({ id: horse.id, name: horse.name })),
    })
  }

  const fallback = await raceReadService.getCurrentRaceSummary()
  if (!fallback) return res.status(404).json({ error: 'No race seeded' })
  return res.json({
    ...fallback,
    config: sanitizeRaceConfig(fallback.config),
  })
})

/**
 * GET /race/previous - Get the last completed race
 */
router.get('/previous', requireApiToken, async (req, res) => {
  const race = RaceState.getPreviousRace()
  if (race) return res.json(publicRaceSummary(race))
  const fallback = await raceReadService.getPreviousRaceSummary()
  return res.json(fallback ? publicRaceSummary(fallback) : fallback)
})

/**
 * GET /race/history - Get race history (last 20 races)
 */
router.get('/history', requireApiToken, async (req, res) => {
  const history = RaceState.getHistory() // fixed
  if (history.length > 0) return res.json(history.map(publicRaceSummary))
  const fallback = await raceReadService.getRaceHistory(20)
  return res.json(fallback.map(publicRaceSummary))
})

router.get('/ticks/:raceRef', requireApiToken, async (req, res) => {
  const { raceRef } = req.params
  if (rejectIfArtifactUnavailable(raceRef, res)) return
  const pre = RaceState.findPrecomputedByRef(raceRef)
  if (pre) return res.json({ raceRef: pre.raceRef, ticks: pre.ticks })
  const ticks = await raceReadService.getRawTicks(raceRef)
  if (!ticks) return res.status(404).json({ error: 'Race not found' })
  return res.json({ raceRef: raceRef.toUpperCase(), ticks })
})

/**
 * GET /race/ticks-final/:raceRef - Canonical positions per tick from final matrix
 */
router.get('/ticks-final/:raceRef', requireApiToken, async (req, res) => {
  const { raceRef } = req.params
  if (rejectIfArtifactUnavailable(raceRef, res)) return
  const pre = RaceState.findPrecomputedByRef(raceRef)
  if (pre?.finalHorseStateMatrix) {
    const out = pre.finalHorseStateMatrix.map((states, i) => ({
      tickIndex: i,
      positions: states.map((s) => s.position),
    }))
    return res.json({ raceRef: pre.raceRef, ticksFinal: out })
  }

  const out = await raceReadService.getFinalTicks(raceRef)
  if (!out) return res.status(404).json({ error: 'Race not found' })
  return res.json({ raceRef: raceRef.toUpperCase(), ticksFinal: out })
})

/**
 * GET /race/timeline/:raceRef - Compact event timeline
 */
router.get('/timeline/:raceRef', requireApiToken, async (req, res) => {
  const { raceRef } = req.params
  if (rejectIfArtifactUnavailable(raceRef, res)) return
  const pre = RaceState.findPrecomputedByRef(raceRef)
  if (pre?.eventTimeline) {
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
    return res.json({ raceRef: pre.raceRef, timeline: out })
  }

  const out = await raceReadService.getTimeline(raceRef)
  if (!out) return res.status(404).json({ error: 'Race not found' })
  return res.json({ raceRef: raceRef.toUpperCase(), timeline: out })
})

router.get('/results/:raceRef', requireApiToken, async (req, res) => {
  const { raceRef } = req.params
  if (rejectIfArtifactUnavailable(raceRef, res)) return
  const pre = RaceState.findPrecomputedByRef(raceRef)
  if (pre?.authoritativeFinish) {
    return respondWithFinishPayload(res, pre.authoritativeFinish)
  }

  if (pre) {
    return respondWithFinishPayload(res, {
      raceRef: pre.raceRef,
      timestampUtc: pre.endTime?.toISOString() ?? '',
      winnerId: pre.winnerId,
      finishOrder: pre.finishOrder,
      finishTimesMs: pre.finishTimesMs,
      finishTickIndex: pre.finishTickIndex,
    })
  }

  const fallback = await raceReadService.getRaceResults(raceRef)
  if (!fallback) return res.status(404).json({ error: 'Race not found' })
  return res.json(fallback)
})

/**
 * GET /race/config - Public broadcast config for clients
 */
router.get('/config', requireApiToken, (req, res) => {
  try {
    const pubKey = getPublicKey()
    const keyId = getPublicKeyId()
    res.json({
      protoVer: 2,
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
