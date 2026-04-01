import { MasterTimeline } from '../timeline/masterTimeline.js';
import { activeRaces } from './activeRaceMemory.js';
import { RaceState } from './raceState.js';
import { logEvent } from '../utils/logEvent.js';
import { getRaceRepository } from '../db/raceRepository.js';
const raceRepository = getRaceRepository();
export function releaseRace(raceId) {
    try {
        // Clear all timers tagged for this raceId
        MasterTimeline.clearAllForRace(raceId);
        // Remove catch-up snapshot
        activeRaces.delete(raceId);
        // Clear runtime and precomputed references
        const cur = RaceState.getCurrentRace();
        if (cur?.id === raceId) {
            RaceState.setCurrentRace(null);
        }
        const pre = RaceState.getPrecomputedRace();
        if (pre?.id === raceId) {
            // completeRace() archives to history, updates previousRace, and clears
            // both precomputed and currentRace in one step.
            RaceState.completeRace();
        }
        void raceRepository.markRaceArchived(raceId).catch(() => { });
        logEvent('cleanup:released', { raceId });
    }
    catch (e) {
        logEvent('cleanup:error', { raceId, error: e?.message ?? String(e) });
    }
}
