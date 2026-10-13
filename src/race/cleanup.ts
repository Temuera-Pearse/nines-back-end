import { MasterTimeline } from '../timeline/masterTimeline.js'
import { activeRaces } from './activeRaceMemory.js'
import { RaceState } from './raceState.js'
import { logEvent } from '../utils/logEvent.js'
import { getRaceRepository } from '../db/raceRepository.js'

const raceRepository = getRaceRepository()

export async function releaseRace(raceId: string): Promise<void> {
  let raceRef: string | null = null
  try {
    const pre = RaceState.getPrecomputedRace()
    raceRef = pre?.raceRef ?? null

    // The database transition is authoritative. Keep process-local recovery
    // state intact until the conditional archival transaction commits.
    await raceRepository.markRaceArchived(raceId)

    // Clear all timers tagged for this raceId
    MasterTimeline.clearAllForRace(raceId)
    // Remove catch-up snapshot
    activeRaces.delete(raceId)
    // Clear runtime and precomputed references
    const cur = RaceState.getCurrentRace()
    if (cur?.raceId === raceId) {
      RaceState.setCurrentRace(null)
    }
    if (pre?.raceId === raceId) {
      // completeRace() archives to history, updates previousRace, and clears
      // both precomputed and currentRace in one step.
      RaceState.completeRace()
    }
    logEvent('cleanup:released', { raceRef })
  } catch (e: any) {
    logEvent('cleanup:error', { raceRef, error: e?.message ?? String(e) })
    throw e
  }
}
