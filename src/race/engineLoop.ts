import { EventEmitter } from 'events'
import { performance } from 'perf_hooks'
import { streamPrecomputedTickAt } from './raceEngine.js'
import { RaceState } from './raceState.js'
import { logEvent } from '../utils/logEvent.js'
import { engineMetrics } from '../metrics/engineMetrics.js'

// Timing constants (20Hz loop)
export const TICK_RATE = 20
export const TICK_INTERVAL = 50
export const DRIFT_TOLERANCE = 5

export const engineEvents = new EventEmitter()

let running = false
let timerRef: NodeJS.Timeout | null = null
let tickCount = 0
let lastTickTime: number | null = null
let nextTickTime: number | null = null

function loop() {
  if (!running) return

  const now = performance.now()

  // Compute drift from planned nextTickTime
  if (nextTickTime === null) nextTickTime = now
  const drift = now - nextTickTime

  if (Math.abs(drift) > DRIFT_TOLERANCE) {
    logEvent('engine:drift-warn', { driftMs: Number(drift.toFixed(2)) })
  }

  // Metrics: before tick
  engineMetrics.beforeTick(tickCount)

  // Always emit a tick and stream precomputed positions
  engineEvents.emit('engineTick', { tick: tickCount, timestamp: Date.now() })
  try {
    // Stream by authoritative tick index
    streamPrecomputedTickAt(tickCount)
  } catch (e: any) {
    logEvent('engine:stream-error', { error: e?.message ?? String(e) })
  }

  // Metrics: after tick
  engineMetrics.afterTick(tickCount, drift)

  // Stop automatically once last tick is emitted
  const pre = RaceState.getPrecomputedRace()
  if (pre && tickCount >= pre.ticks.length - 1) {
    stop()
    return
  }

  // Advance schedule with self-correcting nextTickTime
  lastTickTime = now
  nextTickTime += TICK_INTERVAL
  tickCount += 1

  const delay = Math.max(0, nextTickTime - performance.now())
  timerRef = setTimeout(loop, delay)
}

export function start(): void {
  if (running) return
  running = true
  tickCount = 0
  lastTickTime = performance.now()
  nextTickTime = lastTickTime // start immediately
  engineMetrics.startRace(TICK_INTERVAL)
  logEvent('engine:start', { hz: TICK_RATE, intervalMs: TICK_INTERVAL })
  timerRef = setTimeout(loop, 0)
}

export function stop(): void {
  if (!running) return
  running = false
  if (timerRef) {
    clearTimeout(timerRef)
    timerRef = null
  }
  engineMetrics.stopRace()
  logEvent('engine:stop', { ticksEmitted: tickCount })
}

export function reset(): void {
  stop()
  tickCount = 0
  lastTickTime = null
  nextTickTime = null
  engineMetrics.resetMetrics()
  logEvent('engine:reset', {})
}

export function isRunning(): boolean {
  return running
}
