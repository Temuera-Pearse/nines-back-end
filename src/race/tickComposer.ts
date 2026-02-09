import type {
  FinalHorseStateMatrix,
  FinalHorseStateTick,
} from './events/effects.js'
import type { EventTimeline, EventInstance } from './events/timeline.js'

export type BroadcastState = 'idle' | 'countdown' | 'racing' | 'results'

export type ComposedHorse = Readonly<{
  id: string
  position: number
  lane: number
  speed: number
  isStunned: boolean
  isRemoved: boolean
  activeEvents: ReadonlyArray<string>
}>

export type ComposedTick = Readonly<{
  tickIndex: number
  timestamp: number
  horses: ReadonlyArray<ComposedHorse>
  events: ReadonlyArray<EventInstance>
  state: BroadcastState
}> &
  Readonly<Record<string, unknown>> // allows spreading metadata

type Pool<T> = {
  acquire(size: number): T[]
  release(arr: T[]): void
}

// Simple array pool to reduce GC pressure for per-tick arrays.
// We avoid pooling objects with differing shapes; arrays are pooled and frozen per tick.
function makeArrayPool<T>(): Pool<T> {
  const stash: T[][] = []
  return {
    acquire(size: number) {
      const arr = stash.pop() ?? []
      arr.length = 0
      // Pre-allocate capacity where possible
      if ((arr as unknown as { capacity?: number }).capacity !== undefined) {
        // noop; JS arrays don't have capacity
      }
      return arr
    },
    release(arr: T[]) {
      arr.length = 0
      stash.push(arr)
    },
  }
}

// 60-second deterministic cycle mapping (seconds in minute)
const SECS = {
  idleStart: 0,
  idleEnd: 26,
  countdownStart: 27,
  countdownEnd: 29,
  raceStart: 30,
  raceEnd: 50,
  resultsStart: 51,
  resultsEnd: 59,
} as const

function resolveBroadcastState(
  tickIndex: number,
  tickDurationMs: number
): BroadcastState {
  const sec = Math.floor(((tickIndex * tickDurationMs) / 1000) % 60)
  if (sec >= SECS.idleStart && sec <= SECS.idleEnd) return 'idle'
  if (sec >= SECS.countdownStart && sec <= SECS.countdownEnd) return 'countdown'
  if (sec >= SECS.raceStart && sec <= SECS.raceEnd) return 'racing'
  return 'results'
}

// Helper: compose a single horse state into a lightweight broadcast shape.
function composeHorse(h: FinalHorseStateTick): ComposedHorse {
  // Keep it shallow; activeEvents is already a frozen array upstream.
  return Object.freeze({
    id: h.horseId,
    position: h.position,
    lane: h.lane,
    speed: h.speed,
    isStunned: h.isStunned,
    isRemoved: h.isRemoved,
    activeEvents: h.activeEvents,
  })
}

// Helper: get events for tick; already frozen instances in EventTimeline
function getEventsForTick(
  eventTimeline: EventTimeline,
  tickIndex: number
): ReadonlyArray<EventInstance> {
  return (
    eventTimeline.get(tickIndex) ??
    (Object.freeze([]) as ReadonlyArray<EventInstance>)
  )
}

/**
 * Compose broadcast-ready ticks from final horse states and event timeline.
 * - Immutable output (Object.freeze at all levels)
 * - Minimal cloning; per-tick arrays are newly created, pooled to reduce GC
 * - Time per tick composition target <= 0.1ms for typical sizes
 */
export function composeTicks(
  finalHorseStateMatrix: FinalHorseStateMatrix,
  eventTimeline: EventTimeline,
  tickDurationMs: number,
  metadata?: Readonly<Record<string, unknown>>
): ReadonlyArray<ComposedTick> {
  const totalTicks = finalHorseStateMatrix.length
  if (totalTicks === 0) return Object.freeze([])

  const ticksPool = makeArrayPool<ComposedTick>()
  const horsesPool = makeArrayPool<ComposedHorse>()

  const out = ticksPool.acquire(totalTicks)

  // Use a monotonic timestamp baseline derived from tick index for determinism
  // Consumers can override with real-time if needed; here we keep pure math.
  for (let tickIndex = 0; tickIndex < totalTicks; tickIndex++) {
    const baseHorses = finalHorseStateMatrix[tickIndex]
    const horsesArr = horsesPool.acquire(baseHorses.length)

    // Compose horses
    for (let i = 0; i < baseHorses.length; i++) {
      // Compose and freeze individual horse entry (tiny objects, cheap)
      horsesArr.push(composeHorse(baseHorses[i]))
    }

    const eventsArr = getEventsForTick(eventTimeline, tickIndex)
    const state = resolveBroadcastState(tickIndex, tickDurationMs)
    const timestamp = tickIndex * tickDurationMs

    // Freeze horses array shallowly for immutability
    const frozenHorses = Object.freeze([...horsesArr])
    // Release pooled array shell to reduce retained memory (objects are new & frozen above)
    horsesPool.release(horsesArr)

    // Merge metadata into the tick object without copying large arrays
    const tickObj = Object.freeze({
      tickIndex,
      timestamp,
      horses: frozenHorses,
      events: eventsArr,
      state,
      ...(metadata ?? {}),
    }) as ComposedTick

    out.push(tickObj)
  }

  // Freeze final composed ticks list (shallow)
  const frozenOut = Object.freeze([...out])
  ticksPool.release(out)
  return frozenOut
}
