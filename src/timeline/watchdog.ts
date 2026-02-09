import { RaceState } from '../race/raceState.js'
import { MasterTimeline } from './masterTimeline.js'
import { releaseRace } from '../race/cleanup.js'
import { logEvent } from '../utils/logEvent.js'
import { activeRaces } from '../race/activeRaceMemory.js'

const WATCHDOG_INTERVAL_MS = 1000
const MAX_RACE_DRIFT_MS = 500 // warn threshold
let watchdogTimerId = 'watchdog:main'
let running = false

export function startWatchdog(): void {
  if (running) return
  running = true
  MasterTimeline.setInterval(watchdogTimerId, WATCHDOG_INTERVAL_MS, () => {
    const pre = RaceState.getPrecomputedRace()
    const cur = RaceState.getCurrentRace()
    const sm = RaceState.getStateMachine()

    if (!pre || !cur) return

    if (pre.startTime && !pre.endTime) {
      // Fallback-only: observe currentTickIndex authority and timers presence.
      const rec = activeRaces.get(pre.id)
      if (rec && typeof rec.currentTickIndex === 'number') {
        logEvent('watchdog:tick-observe', {
          raceId: pre.id,
          currentTickIndex: rec.currentTickIndex,
        })
      }
    }

    // State sanity: running but no timers registered for this race
    if (sm.is('race_running')) {
      const timersForRace = MasterTimeline.getTimerIds().filter((id) =>
        id.includes(pre.id),
      )
      if (timersForRace.length === 0) {
        logEvent('watchdog:missing-timers', { raceId: pre.id })
        // Scheduler cadence remains; no forced re-schedule to avoid changing timing
      }
    }
  })
}

export function stopWatchdog(): void {
  running = false
  MasterTimeline.clear(watchdogTimerId)
}
