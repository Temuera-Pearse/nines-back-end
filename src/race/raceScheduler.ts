import { RaceWebSocketServer } from '../websocket/wsServer.js'
import {
  seedPrecomputedRace,
  startPrecomputedRace,
  streamPrecomputedTicks,
} from './raceEngine.js'
import { RaceState } from './raceState.js'

const ts = () => new Date().toISOString()
let schedulerInterval: NodeJS.Timeout | null = null

/**
 * Race scheduler that manages the timing of races
 */
export class RaceScheduler {
  /**
   * Start the race scheduler
   */
  static start(): void {
    if (schedulerInterval) {
      console.log('Scheduler already running')
      return
    }
    console.log(`[${ts()}][SCHED] Starting race scheduler`)

    schedulerInterval = setInterval(() => {
      const now = new Date()
      const seconds = now.getSeconds()

      // Countdown logs
      if (seconds >= 25 && seconds < 30) {
        const remaining = 30 - seconds
        console.log(
          `[${ts()}][RACE][COUNTDOWN] Race countdown started: T-${remaining}s`
        )
      }

      if (seconds === 27) {
        const seeded = seedPrecomputedRace(new Date(now.getTime()))
        RaceState.setPrecomputedRace(seeded)
        console.log(`[${ts()}][RACE][${seeded.id}] Seeded`)
      } else if (seconds === 30) {
        const pre = RaceState.getPrecomputedRace()
        if (!pre) {
          const seeded = seedPrecomputedRace(new Date(now.getTime()))
          RaceState.setPrecomputedRace(seeded)
          console.log(`[${ts()}][RACE][${seeded.id}] Seeded (late)`)
        }
        const started = startPrecomputedRace(now)
        console.log(
          `[${ts()}][RACE][${started.id}] Started at ${now.toISOString()}`
        )
      } else if (seconds > 30 && seconds <= 50) {
        try {
          streamPrecomputedTicks(now)
        } catch (e: any) {
          console.warn(`[${ts()}][ERROR][SCHED] ${e?.message ?? e}`)
        }
      } else if (seconds === 51) {
        RaceState.completeRace()
        const pre = RaceState.getPreviousRace()
        console.log(
          `[${ts()}][RACE][${pre?.id ?? 'unknown'}] Archived previous race`
        )
      }
    }, 1000)
  }

  /**
   * Stop the race scheduler
   */
  static stop(): void {
    if (schedulerInterval) {
      clearInterval(schedulerInterval)
      schedulerInterval = null
      console.log(`[${ts()}][SCHED] Race scheduler stopped`)
    }
  }
}
