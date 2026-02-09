import { MasterTimeline } from '../timeline/masterTimeline.js'
import { activeRaces } from './activeRaceMemory.js'
import { RaceState } from './raceState.js'
import { logEvent } from '../utils/logEvent.js'

export function releaseRace(raceId: string): void {
  try {
    // Clear all timers tagged for this raceId
    MasterTimeline.clearAllForRace(raceId)
    // Remove catch-up snapshot
    activeRaces.delete(raceId)
    // Clear runtime and precomputed references
    const cur = RaceState.getCurrentRace()
    if (cur?.id === raceId) {
      RaceState.setCurrentRace(null)
    }
    const pre = RaceState.getPrecomputedRace()
    if (pre?.id === raceId) {
      RaceState.setPrecomputedRace(null)
    }
    logEvent('cleanup:released', { raceId })
  } catch (e: any) {
    logEvent('cleanup:error', { raceId, error: e?.message ?? String(e) })
  }
}
