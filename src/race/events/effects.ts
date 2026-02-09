import type { EventDefinition } from './catalog.js'
import type { EventTimeline, EventInstance } from './timeline.js'
import { hashStringToInt } from '../../race/rng.js'

export type HorseBaseTick = Readonly<{
  horseId: string
  position: number
  lane: number
  speed: number
}>

export type HorsePathMatrix = ReadonlyArray<ReadonlyArray<HorseBaseTick>>

export type FinalHorseStateTick = Readonly<{
  horseId: string
  position: number
  lane: number
  speed: number
  isStunned: boolean
  isRemoved: boolean
  activeEvents: ReadonlyArray<string>
}>

export type FinalHorseStateMatrix = ReadonlyArray<
  ReadonlyArray<FinalHorseStateTick>
>

// Effect magnitudes (units and ticks)
const OFFSETS = Object.freeze({
  hookShotBackward: 15,
  rocketBoostForward: 20,
  chainStunDuration: 20,
})

const NEGATIVE_EVENT_IDS = new Set<string>([
  'hook_shot',
  'bomb_throw',
  'ufo_abduction',
  'chain_reaction',
])

// Utility: deterministic single index from instanceId
function pickIndex(instance: EventInstance, count: number, salt = ''): number {
  const h = hashStringToInt(`${instance.instanceId}${salt}`)
  return count === 0 ? 0 : h % count
}
function pickTwoDistinct(
  instance: EventInstance,
  count: number
): [number, number] {
  if (count <= 1) return [0, 0]
  const a = pickIndex(instance, count, 'A')
  const bRaw = pickIndex(instance, count - 1, 'B')
  const b = bRaw >= a ? bRaw + 1 : bRaw
  return [a, b]
}

// 1) Explicit timing: include startTick
type ActiveWindow = { id: string; startTick: number; endTick: number }
type SwapWindow = { withHorseId: string; startTick: number; endTick: number }

// Optional polish: clearer label for global stun from chain_reaction
const CHAIN_STUN_ID = 'chain_stun'

/**
 * Apply deterministic event effects over precomputed base paths.
 * Pure function: no randomness, no mutation, immutable output.
 */
export function applyEventEffects(
  baseHorsePaths: Readonly<HorsePathMatrix>,
  eventTimeline: Readonly<EventTimeline>,
  eventCatalog: Readonly<EventDefinition[]>
): FinalHorseStateMatrix {
  const totalTicks = baseHorsePaths.length
  if (totalTicks === 0) return Object.freeze([]) as FinalHorseStateMatrix
  const horsesAt0 = baseHorsePaths[0]
  const horseIds = horsesAt0.map((h) => h.horseId)

  const catalogOrder = new Map<string, number>()
  eventCatalog.forEach((d, i) => catalogOrder.set(d.id, i))
  const defById = new Map<string, Readonly<EventDefinition>>()
  for (const d of eventCatalog) defById.set(d.id, d)

  const stunUntil = new Map<string, number>()
  const removed = new Map<string, boolean>()
  const activeEventsWindows = new Map<string, ActiveWindow[]>()
  const activeSwaps = new Map<string, SwapWindow>()

  const prevFinalPosition = new Map<string, number>()
  for (const h of horseIds)
    prevFinalPosition.set(
      h,
      baseHorsePaths[0].find((x) => x.horseId === h)?.position ?? 0
    )

  const result: FinalHorseStateTick[][] = new Array(totalTicks)

  for (let tick = 0; tick < totalTicks; tick++) {
    const baseAtTick = baseHorsePaths[tick]
    const idxByHorse = new Map<string, number>()
    for (let i = 0; i < baseAtTick.length; i++)
      idxByHorse.set(baseAtTick[i].horseId, i)

    // Events at this tick in deterministic catalog order
    const eventsHere = (eventTimeline.get(tick) ?? []).slice().sort((a, b) => {
      const ao = catalogOrder.get(a.id) ?? Number.MAX_SAFE_INTEGER
      const bo = catalogOrder.get(b.id) ?? Number.MAX_SAFE_INTEGER
      if (ao !== bo) return ao - bo
      return a.instanceId.localeCompare(b.instanceId)
    })

    const rerouteIfLucky = (targetIdx: number): number => {
      if (targetIdx < 0 || targetIdx >= baseAtTick.length) return targetIdx
      const targetId = baseAtTick[targetIdx].horseId
      if (!isEventActive(targetId, 'luck_charm', tick, activeEventsWindows)) {
        return targetIdx
      }
      for (let step = 1; step < baseAtTick.length; step++) {
        const nextIdx = (targetIdx + step) % baseAtTick.length
        const candidate = baseAtTick[nextIdx].horseId
        if (!removed.get(candidate)) return nextIdx
      }
      return targetIdx
    }

    for (const ev of eventsHere) {
      const def = defById.get(ev.id)
      if (!def) continue

      // position_swap: establish symmetric swap window (swap lanes too)
      if (ev.id === 'position_swap') {
        if (baseAtTick.length < 2) continue
        const [ia, ib] = pickTwoDistinct(ev, baseAtTick.length)
        const ha = baseAtTick[ia].horseId
        const hb = baseAtTick[ib].horseId
        if (removed.get(ha) || removed.get(hb)) continue
        const endTick = tick + def.durationTicks
        activeSwaps.set(ha, { withHorseId: hb, startTick: tick, endTick })
        activeSwaps.set(hb, { withHorseId: ha, startTick: tick, endTick })
        markActive(ha, ev.id, tick, endTick, activeEventsWindows)
        markActive(hb, ev.id, tick, endTick, activeEventsWindows)
        continue
      }

      if (ev.id === 'ufo_abduction') {
        const i0 = pickIndex(ev, baseAtTick.length)
        const ix = rerouteIfLucky(i0)
        const horseId = baseAtTick[ix].horseId
        // Mark removed permanently; freeze event visibility deterministically
        removed.set(horseId, true)
        markActive(
          horseId,
          ev.id,
          tick,
          Number.POSITIVE_INFINITY,
          activeEventsWindows
        )
        continue
      }

      if (ev.id === 'chain_reaction') {
        // Global stun: preserve behavior; semantic tag clarity
        for (const bt of baseAtTick) {
          if (removed.get(bt.horseId)) continue
          const endTick = tick + OFFSETS.chainStunDuration
          stunUntil.set(
            bt.horseId,
            Math.max(stunUntil.get(bt.horseId) ?? tick, endTick)
          )
          markActive(
            bt.horseId,
            CHAIN_STUN_ID,
            tick,
            endTick,
            activeEventsWindows
          )
          markActive(
            bt.horseId,
            ev.id,
            tick,
            tick + (def.durationTicks || 0),
            activeEventsWindows
          )
        }
        continue
      }

      if (def.affectsMultipleHorses) {
        for (const bt of baseAtTick) {
          if (removed.get(bt.horseId)) continue
          applyEffect(ev, def, bt.horseId, tick, stunUntil, activeEventsWindows)
        }
      } else {
        const i0 = pickIndex(ev, baseAtTick.length)
        const ix = NEGATIVE_EVENT_IDS.has(ev.id) ? rerouteIfLucky(i0) : i0
        const horseId = baseAtTick[ix].horseId
        if (removed.get(horseId)) continue
        applyEffect(ev, def, horseId, tick, stunUntil, activeEventsWindows)
      }
    }

    const finalTickStates: FinalHorseStateTick[] = new Array(baseAtTick.length)

    for (let i = 0; i < baseAtTick.length; i++) {
      const base = baseAtTick[i]
      const horseId = base.horseId
      const wasRemoved = removed.get(horseId) === true
      const stunned = (stunUntil.get(horseId) ?? -1) > tick

      const basePrev =
        tick > 0 ? baseHorsePaths[tick - 1][i].position : base.position
      const baseDelta = tick > 0 ? base.position - basePrev : 0
      const prevFinal = prevFinalPosition.get(horseId) ?? base.position

      // Instant offsets exactly at start tick
      let offset = 0
      if (
        isEventActive(horseId, 'hook_shot', tick, activeEventsWindows, true)
      ) {
        offset -= OFFSETS.hookShotBackward
      }
      if (
        isEventActive(horseId, 'rocket_boost', tick, activeEventsWindows, true)
      ) {
        offset += OFFSETS.rocketBoostForward
      }

      const moveDelta = stunned ? 0 : baseDelta
      let candidatePos = Math.max(0, prevFinal + moveDelta + offset)

      // Swap overlay: swap positions AND lanes during active window
      let finalLane = base.lane
      const swap = activeSwaps.get(horseId)
      if (swap && tick >= swap.startTick && tick < swap.endTick) {
        const otherIdx = idxByHorse.get(swap.withHorseId)
        if (otherIdx !== undefined) {
          // Position follows the other horse's progression deterministically
          const otherPrevFinal =
            prevFinalPosition.get(swap.withHorseId) ??
            baseHorsePaths[Math.max(0, tick - 1)][otherIdx].position
          const otherBasePrev =
            tick > 0
              ? baseHorsePaths[tick - 1][otherIdx].position
              : baseHorsePaths[0][otherIdx].position
          const otherBaseDelta =
            tick > 0
              ? baseHorsePaths[tick][otherIdx].position - otherBasePrev
              : 0
          const otherStunned = (stunUntil.get(swap.withHorseId) ?? -1) > tick
          const otherMoveDelta = otherStunned ? 0 : otherBaseDelta
          let otherOffset = 0
          if (
            isEventActive(
              swap.withHorseId,
              'hook_shot',
              tick,
              activeEventsWindows,
              true
            )
          ) {
            otherOffset -= OFFSETS.hookShotBackward
          }
          if (
            isEventActive(
              swap.withHorseId,
              'rocket_boost',
              tick,
              activeEventsWindows,
              true
            )
          ) {
            otherOffset += OFFSETS.rocketBoostForward
          }
          candidatePos = Math.max(
            0,
            otherPrevFinal + otherMoveDelta + otherOffset
          )
          // Deterministic rule: lanes swap during position_swap
          finalLane = baseHorsePaths[tick][otherIdx].lane
        }
      }

      let finalPos = candidatePos
      let finalSpeed = wasRemoved ? 0 : base.speed
      if (wasRemoved) {
        // Removed horses freeze position and speed from last final; no new effects apply after removal
        finalPos = prevFinal
      }

      // Active events visible: removed horses retain existing windows deterministically
      const activeIds = (activeEventsWindows.get(horseId) ?? [])
        .filter((w) => tick >= w.startTick && tick < w.endTick)
        .map((w) => w.id)

      finalTickStates[i] = Object.freeze({
        horseId,
        position: finalPos,
        lane: finalLane,
        speed: finalSpeed,
        isStunned: stunned,
        isRemoved: wasRemoved,
        activeEvents: Object.freeze(activeIds),
      })

      prevFinalPosition.set(horseId, finalPos)
    }

    for (const [hid, sw] of Array.from(activeSwaps.entries())) {
      if (tick >= sw.endTick) activeSwaps.delete(hid)
    }

    result[tick] = finalTickStates

    Object.freeze(finalTickStates)
  }

  return Object.freeze(result) as FinalHorseStateMatrix

  // --- Helpers (timing explicit) ---

  function applyEffect(
    ev: EventInstance,
    def: Readonly<EventDefinition>,
    horseId: string,
    tick: number,
    stunUntilMap: Map<string, number>,
    active: Map<string, ActiveWindow[]>
  ) {
    const endTick = tick + def.durationTicks
    markActive(horseId, ev.id, tick, endTick, active)

    if (ev.id === 'bomb_throw') {
      stunUntilMap.set(
        horseId,
        Math.max(stunUntilMap.get(horseId) ?? tick, endTick)
      )
    }
    // hook_shot and rocket_boost: instantaneous offsets at start tick handled in render
    // luck_charm: marker only
  }

  function markActive(
    horseId: string,
    id: string,
    startTick: number,
    endTick: number,
    active: Map<string, ActiveWindow[]>
  ) {
    const arr = active.get(horseId) ?? []
    arr.push({ id, startTick, endTick })
    active.set(horseId, arr)
  }

  function isEventActive(
    horseId: string,
    id: string,
    tick: number,
    active: Map<string, ActiveWindow[]>,
    onlyStartAtTick = false
  ): boolean {
    const arr = active.get(horseId)
    if (!arr) return false
    if (onlyStartAtTick) {
      // Explicit start timing
      return arr.some((w) => w.id === id && w.startTick === tick)
    }
    return arr.some(
      (w) => w.id === id && tick >= w.startTick && tick < w.endTick
    )
  }
}
