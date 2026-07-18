import { MasterTimeline } from '../timeline/masterTimeline.js'
import { activeRaces } from './activeRaceMemory.js'
import { RaceState } from './raceState.js'
import { logEvent } from '../utils/logEvent.js'
import { getRaceRepository } from '../db/raceRepository.js'

const raceRepository = getRaceRepository()

export function releaseRace(raceId: string): void {
  let raceRef: string | null = null
  try {
    // Clear all timers tagged for this raceId
    MasterTimeline.clearAllForRace(raceId)
    // Remove catch-up snapshot
    activeRaces.delete(raceId)
    // Clear runtime and precomputed references
    const cur = RaceState.getCurrentRace()
    if (cur?.raceId === raceId) {
      RaceState.setCurrentRace(null)
    }
    const pre = RaceState.getPrecomputedRace()
    raceRef = pre?.raceRef ?? null
    if (pre?.raceId === raceId) {
      // completeRace() archives to history, updates previousRace, and clears
      // both precomputed and currentRace in one step.
      RaceState.completeRace()
    }
    void raceRepository.markRaceArchived(raceId).catch(() => {})
    logEvent('cleanup:released', { raceRef })
  } catch (e: any) {
    logEvent('cleanup:error', { raceRef, error: e?.message ?? String(e) })
  }
}
