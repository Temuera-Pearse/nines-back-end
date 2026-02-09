import { RaceState } from '../race/raceState.js'
import { logEvent } from '../utils/logEvent.js'
import { activeRaces } from '../race/activeRaceMemory.js'
import { MasterTimeline } from '../timeline/masterTimeline.js'

export function runRestartRecovery(): void {
  const pre = RaceState.getPrecomputedRace()
  if (!pre || !pre.startTime) {
    logEvent('restart:no-precomputed', {})
    return
  }

  // Ensure current seed is available for racing/results after restart
  try {
    if (pre.config?.seed) {
      RaceState.setCurrentSeed(pre.config.seed)
      logEvent('restart:seed-restored', {
        raceId: pre.id,
        seed: pre.config.seed,
      })
    }
  } catch {
    // non-fatal
  }

  // On restart, avoid wall-clock derived progress; let engine tick authority resume.
  try {
    MasterTimeline.schedule(
      `recovery:${pre.id}:marker`,
      0,
      () => {
        // marker only; scheduler continues streaming
      },
      pre.id,
    )

    logEvent('restart:resume', {
      raceId: pre.id,
      currentTickIndex: activeRaces.get(pre.id)?.currentTickIndex ?? -1,
      ticksAvailable: activeRaces.get(pre.id)?.ticks.length ?? 0,
    })
  } catch (e: any) {
    logEvent('restart:error', {
      raceId: pre.id,
      error: e?.message ?? String(e),
    })
  }
}
