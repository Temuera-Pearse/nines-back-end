import { RaceState } from '../race/raceState.js'
import { logEvent } from '../utils/logEvent.js'
import { activeRaces } from '../race/activeRaceMemory.js'
import { MasterTimeline } from '../timeline/masterTimeline.js'
import { seedPrecomputedRace } from '../race/raceEngine.js'
import { isSimulationMode } from '../runtime/simulationMode.js'

function regenerateSimulationRace(): void {
  try {
    const fixed = process.env.FIXED_SEED?.trim()
    const cycleId = RaceState.bumpCycle()
    RaceState.setCurrentSeed(fixed || `simulation-restart-${cycleId}`)
    const seeded = seedPrecomputedRace()
    RaceState.setPrecomputedRace(seeded)
    logEvent('restart:simulation-regenerated', { raceRef: seeded.raceRef })
  } catch (e: any) {
    logEvent('restart:simulation-regenerate-error', {
      error: e?.message ?? String(e),
    })
  }
}

export function runRestartRecovery(): void {
  const pre = RaceState.getPrecomputedRace()
  if (!pre || !pre.startTime) {
    if (isSimulationMode() && !pre) {
      regenerateSimulationRace()
    }
    logEvent('restart:no-precomputed', {})
    return
  }

  // Ensure current seed is available for racing/results after restart
  try {
    if (pre.config?.seed) {
      RaceState.setCurrentSeed(pre.config.seed)
      logEvent('restart:seed-restored', {
        raceRef: pre.raceRef,
      })
    }
  } catch {
    // non-fatal
  }

  // On restart, avoid wall-clock derived progress; let engine tick authority resume.
  try {
    MasterTimeline.schedule(
      `recovery:${pre.raceId}:marker`,
      0,
      () => {
        // marker only; scheduler continues streaming
      },
      pre.raceId,
    )

    logEvent('restart:resume', {
      raceRef: pre.raceRef,
      currentTickIndex: activeRaces.get(pre.raceId)?.currentTickIndex ?? -1,
      ticksAvailable: activeRaces.get(pre.raceId)?.ticks.length ?? 0,
    })
  } catch (e: any) {
    logEvent('restart:error', {
      raceRef: pre.raceRef,
      error: e?.message ?? String(e),
    })
  }
}
