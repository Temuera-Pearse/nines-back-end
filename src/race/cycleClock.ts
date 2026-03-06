import { MasterTimeline } from '../timeline/masterTimeline.js'
import { RaceState } from './raceState.js'
import {
  isRunning,
  start as startEngine,
  stop as stopEngine,
} from './engineLoop.js'
import { getLeaderRole } from '../leader/elector.js'
import { logEvent } from '../utils/logEvent.js'

let running = false
let unsubscribe: null | (() => void) = null
let alignedTimerRef: ReturnType<typeof setTimeout> | null = null

const CLOCK_ID = 'cycleClock:main'

function shouldDriveLifecycle(): boolean {
  // If leader election is enabled, only the leader drives lifecycle.
  if (process.env.LEADER_ELECTION === '1') return getLeaderRole() === 'leader'
  // Otherwise default to a single-instance "leader".
  return (process.env.BROADCAST_ROLE || 'leader') === 'leader'
}

function reconcileEngine(phase: string): void {
  // Only run the high-frequency engine when we actually have an active current race.
  // This avoids a brief restart after the engine naturally stops at the last tick
  // while the 1Hz lifecycle is still in `race_running`.
  const cur = RaceState.getCurrentRace()
  const shouldRun =
    shouldDriveLifecycle() && phase === 'race_running' && cur?.isActive === true
  if (shouldRun && !isRunning()) startEngine()
  if (!shouldRun && isRunning()) stopEngine()
}

/** Schedule the next tick to fire precisely at the next UTC-second boundary. */
function scheduleNextAlignedTick(fn: () => void): void {
  if (!running) return
  const now = Date.now()
  // How many ms until the next whole-second boundary?
  const delay = 1000 - (now % 1000)
  alignedTimerRef = setTimeout(() => {
    if (!running) return
    try {
      fn()
    } catch (e: any) {
      logEvent('cycle:tick-error', {
        error: e?.message ?? String(e),
      })
    }
    scheduleNextAlignedTick(fn)
  }, delay)
}

export function startCycleClock(): void {
  if (running) return
  running = true

  const sm = RaceState.getStateMachine()
  let lastPhase: string | null = null

  unsubscribe = sm.subscribe((phase) => {
    if (phase === lastPhase) return
    lastPhase = phase
    reconcileEngine(phase)
    logEvent('cycle:phase', { phase })
  })

  const tick = () => {
    if (!running) return
    if (!shouldDriveLifecycle()) {
      if (isRunning()) stopEngine()
      return
    }
    reconcileEngine(sm.state)
    try {
      sm.tick()
    } catch (e: any) {
      logEvent('cycle:tick-error', {
        phase: sm.state,
        error: e?.message ?? String(e),
        stack: e?.stack ? String(e.stack) : undefined,
      })
    }
  }

  // Fire once immediately so the state machine catches up to the current UTC second,
  // then schedule all subsequent ticks precisely on UTC-second boundaries.
  tick()
  scheduleNextAlignedTick(tick)
}

export function stopCycleClock(): void {
  running = false
  if (alignedTimerRef !== null) {
    clearTimeout(alignedTimerRef)
    alignedTimerRef = null
  }
  MasterTimeline.clear(CLOCK_ID)
  if (unsubscribe) {
    try {
      unsubscribe()
    } catch {
      // ignore
    }
    unsubscribe = null
  }
  if (isRunning()) stopEngine()
}

export function isCycleClockRunning(): boolean {
  return running
}
