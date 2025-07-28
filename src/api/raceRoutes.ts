import { Router } from 'express'
import { RaceState } from '../race/raceState.js'
import { RaceScheduler } from '../race/raceScheduler.js'

const router = Router()

/**
 * GET /race/current - Get the currently running race
 */
router.get('/current', (req, res) => {
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
router.get('/previous', (req, res) => {
  const race = RaceState.getPreviousRace()
  res.json(race)
})

/**
 * GET /race/history - Get race history (last 20 races)
 */
router.get('/history', (req, res) => {
  const history = RaceState.getRaceHistory()
  res.json(history)
})

/**
 * POST /race/start - Manually trigger a new race (for testing)
 */
router.post('/start', async (req, res) => {
  try {
    await RaceScheduler.triggerRace()
    res.json({ message: 'Race started successfully' })
  } catch (error: any) {
    res.status(400).json({ error: error.message })
  }
})

router.get('/ticks/:raceId', (req, res) => {
  const { raceId } = req.params
  const pre = RaceState.findPrecomputedById(raceId)
  if (!pre) return res.status(404).json({ error: 'Race not found' })
  res.json({ ticks: pre.ticks })
})

router.get('/results/:raceId', (req, res) => {
  const { raceId } = req.params
  const pre = RaceState.findPrecomputedById(raceId)
  if (!pre) return res.status(404).json({ error: 'Race not found' })
  res.json({
    winnerId: pre.winnerId,
    finishOrder: pre.finishOrder,
    finishTimesMs: pre.finishTimesMs,
  })
})

export default router
