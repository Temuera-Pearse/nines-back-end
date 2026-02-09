import {
  RaceConfig,
  HorseSeed,
  PrecomputedRace,
  PrecomputedTick,
  PositionUpdate,
  Race,
  Horse,
} from './raceTypes.js'
import { RaceWebSocketServer } from '../websocket/wsServer.js'
import { activeRaces } from './activeRaceMemory.js'
import { RaceState } from './raceState.js'
import { computeRaceChecksum } from './checksum.js'
import { releaseRace } from './cleanup.js'
import { logEvent } from '../utils/logEvent.js'
import { makeMulberry32, hashStringToInt } from './rng.js'
import { performance } from 'perf_hooks'
import { engineMetrics } from '../metrics/engineMetrics.js'
import { EVENT_CATALOG } from './events/catalog.js'
import { generateEventTimeline, EventTimeline } from './events/timeline.js'
import {
  applyEventEffects,
  HorseBaseTick,
  FinalHorseStateMatrix,
} from './events/effects.js'
import { determineWinner } from './winner.js'
import type { WinnerResult } from './winner.js'
import { FileRacePersistence } from '../persistence/racePersistence.js'

// Easing helpers for smooth curves
const easeInQuad = (t: number) => t * t
const easeOutQuad = (t: number) => t * (2 - t)
const easeInOutQuad = (t: number) =>
  t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t
const easeOutCubic = (t: number) => --t * t * t + 1

export const TRACK_LENGTH = 1000

const VERBOSE = process.env.LOG_VERBOSE === 'true'
const ts = () => new Date().toISOString()
const log = (...args: any[]) => console.log(...args)

let currentRace: Race | null = null
let precomputed: PrecomputedRace | null = null
let lastStreamedIndex: number | null = null
let consecutiveTickFailures = 0
const persistence = new FileRacePersistence()

function persistCompletedRace(pre: PrecomputedRace): void {
  try {
    if (!pre.finalHorseStateMatrix || !pre.eventTimeline) {
      persistence.markUnsaved(pre.id)
      return
    }
    const winner: WinnerResult | null = determineWinner(
      pre.finalHorseStateMatrix,
      pre.finishLine,
      pre.config.dtMs,
    )
    const outcome = Object.freeze({
      winnerId: pre.winnerId,
      finishOrder: pre.finishOrder,
      finishTimesMs: pre.finishTimesMs,
    })
    const data = {
      raceId: pre.id,
      seed: pre.config.seed,
      precomputedPaths: pre.finalHorseStateMatrix,
      eventTimeline: pre.eventTimeline,
      outcome,
      winner: winner!,
      config: pre.config,
      checksum: pre.checksum,
    }
    persistence
      .saveRace(pre.id, data as any)
      .catch((e) => log(`[${ts()}][PERSIST][${pre.id}] ${e?.message || e}`))
  } catch (e: any) {
    log(`[${ts()}][PERSIST][${pre.id}] compose-error ${e?.message || e}`)
    try {
      persistence.markUnsaved(pre.id)
    } catch {}
  }
}

/**
 * Motion Units & Semantics (authoritative)
 * - Distance: meters (trackLength in meters; positions in meters)
 * - Speed: meters/second (baseSpeed per horse; derived speed curve in m/s)
 * - Acceleration/Variance: meters/second as shaping amplitude (no per-tick acceleration integration)
 * - dtMs: milliseconds per tick (e.g., 50ms → 20 ticks/sec)
 * - Duration: milliseconds (durationMs); total ticks = floor(durationMs/dtMs) + 1
 * - Finish clamp: exact crossing interpolated within the tick window; positions are clamped to finishLine deterministically
 * - Stun semantics: movement halts (no application of base delta); speed field remains the base path speed (for display/telemetry), and `isStunned` indicates zero motion
 * - Instantaneous offsets: certain events apply at their start tick (e.g., hook_shot backward, rocket_boost forward) even while stunned
 */

/**
 * Generate deterministic per-horse seeds and base stats using a single RNG.
 * Target average speed ~50 units/s to finish ~1000 units in ~20s.
 */
function generateHorseSeeds(numHorses: number, rng: () => number): HorseSeed[] {
  const horses: HorseSeed[] = []
  for (let i = 0; i < numHorses; i++) {
    const baseSpeed = 40 + rng() * 20 // 40–60 u/s
    const accelVariance = 6 + rng() * 6 // 6–12 u/s as shaping amplitude
    const rngSeed = (rng() * 0x100000000) >>> 0
    horses.push({
      id: `horse-${i}`,
      name: `Horse ${i + 1}`,
      baseSpeed,
      accelVariance,
      rngSeed,
    })
  }
  return horses
}

/**
 * Build a smooth speed curve for a horse using control points and easing.
 * No per-tick RNG; only control point multipliers consume RNG.
 */
function buildSpeedCurve(
  h: HorseSeed,
  totalFrames: number,
  rng: () => number,
): number[] {
  // Control points (frame index, multiplier)
  const p0 = 0
  const p1 = Math.floor(totalFrames * 0.15)
  const p2 = Math.floor(totalFrames * 0.5)
  const p3 = Math.floor(totalFrames * 0.85)
  const p4 = totalFrames

  // Multipliers derived from single RNG; shape phases: slow start → mid dip → late sprint
  const m0 = 0.85 + rng() * 0.15 // 0.85–1.00
  const m1 = 0.95 + rng() * 0.1 // 0.95–1.05
  const m2 = 0.85 + rng() * 0.13 // 0.85–0.98 dip
  const m3 = 1.0 + rng() * 0.1 // 1.00–1.10
  const m4 = 1.05 + rng() * 0.15 // 1.05–1.20

  const curve: number[] = new Array(totalFrames + 1)

  const lerp = (a: number, b: number, t: number) => a + (b - a) * t

  // Segment P0→P1: ramp up (easeOut for quick start)
  for (let f = p0; f <= p1; f++) {
    const t = (f - p0) / (p1 - p0 || 1)
    const mult = lerp(m0, m1, easeOutCubic(t))
    curve[f] = mult * h.baseSpeed
  }
  // Segment P1→P2: slight mid dip (easeInOut)
  for (let f = p1 + 1; f <= p2; f++) {
    const t = (f - (p1 + 1)) / (p2 - (p1 + 1) || 1)
    const mult = lerp(m1, m2, easeInOutQuad(t))
    curve[f] = mult * h.baseSpeed
  }
  // Segment P2→P3: recover (easeOut)
  for (let f = p2 + 1; f <= p3; f++) {
    const t = (f - (p2 + 1)) / (p3 - (p2 + 1) || 1)
    const mult = lerp(m2, m3, easeOutQuad(t))
    curve[f] = mult * h.baseSpeed
  }
  // Segment P3→P4: late sprint (easeIn)
  for (let f = p3 + 1; f <= p4; f++) {
    const t = (f - (p3 + 1)) / (p4 - (p3 + 1) || 1)
    const mult = lerp(m3, m4, easeInQuad(t))
    curve[f] = mult * h.baseSpeed
  }

  // Clamp to plausible min/max considering variance
  const minSpeed = Math.max(20, h.baseSpeed - h.accelVariance)
  const maxSpeed = Math.min(h.baseSpeed + h.accelVariance * 2, 90)
  for (let i = 0; i < curve.length; i++) {
    curve[i] = Math.min(maxSpeed, Math.max(minSpeed, curve[i]))
  }

  return curve
}

/**
 * Deterministically precompute all ticks using a single RNG instance.
 * Positions are integrated from smooth speed curves; no RNG at runtime.
 */
export function generateRaceTicks(
  horses: HorseSeed[],
  config: RaceConfig,
  rng: () => number,
): {
  ticks: PrecomputedTick[]
  finishOrder: string[]
  finishTimesMs: Record<string, number>
  winnerId: string
  // New: exact crossing tick index per horse
  finishTickIndex: Record<string, number>
} {
  const raceId = config.seed
  const finishLine = config.trackLength * config.finishRatio
  const totalFrames = Math.floor(config.durationMs / config.dtMs)
  const dtSec = config.dtMs / 1000

  const positions: Record<string, number> = {}
  const finishTimesMs: Record<string, number> = {}
  const finishTickIndex: Record<string, number> = {}
  const finishedSet = new Set<string>()

  horses.forEach((h) => {
    positions[h.id] = 0
  })

  // Build per-horse speed curves once (deterministic)
  const speedCurves: Record<string, number[]> = {}
  for (const h of horses) {
    speedCurves[h.id] = buildSpeedCurve(h, totalFrames, rng)
  }

  log(
    `[${ts()}][RACE][${raceId}] Precompute begin. finishLine=${finishLine.toFixed(
      2,
    )} track=${config.trackLength}m duration=${config.durationMs}ms dt=${
      config.dtMs
    }ms`,
  )
  log(
    `[${ts()}][TICKS][${raceId}] Precomputing ${
      totalFrames + 1
    } ticks with seed=${config.seed}`,
  )
  if (VERBOSE) {
    horses.forEach((h) =>
      log(
        `[${ts()}][HORSE][${raceId}] Horse-${
          h.id
        } start position=0.00 baseSpeed=${h.baseSpeed.toFixed(
          2,
        )} accelVar=${h.accelVariance.toFixed(2)}`,
      ),
    )
  }

  const ticks: PrecomputedTick[] = []

  for (let frame = 0; frame <= totalFrames; frame++) {
    const tMs = frame * config.dtMs
    const windowStartMs = frame === 0 ? 0 : (frame - 1) * config.dtMs
    const framePositions: Array<{ horseId: string; distance: number }> = []

    for (const h of horses) {
      // If already finished, keep them clamped at finishLine
      if (finishedSet.has(h.id)) {
        positions[h.id] = finishLine
        framePositions.push({ horseId: h.id, distance: positions[h.id] })
        continue
      }

      const speed = speedCurves[h.id][frame] // units per second
      const before = positions[h.id]
      const advance = speed * dtSec
      const afterRaw = before + advance

      if (before < finishLine && afterRaw >= finishLine) {
        // Interpolate crossing within this window
        const delta = Math.max(advance, 1e-12) // avoid div by 0
        const frac = Math.max(0, Math.min(1, (finishLine - before) / delta))
        const crossingMs = windowStartMs + frac * config.dtMs
        finishTimesMs[h.id] = crossingMs
        finishTickIndex[h.id] = Math.floor(crossingMs / config.dtMs)
        positions[h.id] = finishLine
        finishedSet.add(h.id)
      } else {
        // Advance but clamp to finishLine cleanly
        positions[h.id] = Math.min(finishLine, afterRaw)
      }

      framePositions.push({ horseId: h.id, distance: positions[h.id] })
    }

    ticks.push({
      timestampOffsetMs: tMs,
      positions: framePositions,
    })
  }

  // Determine finish order using interpolated crossing timestamps
  const finishOrder = [...horses]
    .sort((a, b) => {
      const ta = finishTimesMs[a.id] ?? Number.POSITIVE_INFINITY
      const tb = finishTimesMs[b.id] ?? Number.POSITIVE_INFINITY
      if (ta !== tb) return ta - tb
      // Tie-break: greater final distance wins among non-finishers, then lexicographic id
      const pa = positions[a.id]
      const pb = positions[b.id]
      if (pa !== pb) return pb - pa
      return a.id.localeCompare(b.id)
    })
    .map((h) => h.id)

  const winnerId = finishOrder[0]
  const sampleFirst = ticks.slice(0, 3)
  const sampleLast = ticks.slice(-3)
  log(
    `[${ts()}][TICKS][${raceId}] Sample ticks: first3=${JSON.stringify(
      sampleFirst,
    )} last3=${JSON.stringify(sampleLast)}`,
  )
  log(
    `[${ts()}][RACE][${raceId}] Projected finish times (ms): ${JSON.stringify(
      finishTimesMs,
    )}`,
  )
  log(`[${ts()}][RACE][${raceId}] Precompute complete. Winner=${winnerId}`)

  return { ticks, finishOrder, finishTimesMs, winnerId, finishTickIndex }
}

/**
 * Create and store a precomputed race shortly before the scheduled start.
 * Uses the single RNG created from the current seed stored in RaceState.
 */
export function seedPrecomputedRace(): PrecomputedRace {
  const seedStr = RaceState.getCurrentSeed()
  const seedInt = RaceState.getCurrentSeedInt()
  if (!seedStr || seedInt == null) {
    throw new Error('Active cycle seed not set')
  }
  // Deterministic raceId derived from seed
  const raceId = `race-${seedInt.toString(16).padStart(8, '0')}`

  const config: RaceConfig = {
    trackLength: TRACK_LENGTH,
    finishRatio: 1.0,
    durationMs: 20000,
    dtMs: 50,
    seed: seedStr,
  }

  // Single RNG instance for entire race
  const rng = makeMulberry32(seedInt)

  const horses = generateHorseSeeds(10, rng)
  const t0 = performance.now()
  const { ticks, finishOrder, finishTimesMs, winnerId, finishTickIndex } =
    generateRaceTicks(horses, config, rng)
  const tTicksMs = performance.now() - t0
  engineMetrics.recordPrecomputeMs(tTicksMs)
  engineMetrics.recordPrecomputePhase('ticks', tTicksMs)
  const finishLine = config.trackLength * config.finishRatio

  // Build deterministic event timeline and canonical final state matrix
  const totalTicks = ticks.length
  const tTimelineStart = performance.now()
  const eventTimeline: EventTimeline = generateEventTimeline(
    seedInt,
    totalTicks,
    EVENT_CATALOG,
  )
  engineMetrics.recordPrecomputePhase(
    'timeline',
    performance.now() - tTimelineStart,
  )
  const tBaseStart = performance.now()
  const basePaths: ReadonlyArray<ReadonlyArray<HorseBaseTick>> =
    buildBaseHorsePaths(horses, ticks, config)
  engineMetrics.recordPrecomputePhase(
    'basePaths',
    performance.now() - tBaseStart,
  )
  const tEffectsStart = performance.now()
  const finalHorseStateMatrix: FinalHorseStateMatrix = applyEventEffects(
    basePaths,
    eventTimeline,
    EVENT_CATALOG,
  )
  engineMetrics.recordPrecomputePhase(
    'effects',
    performance.now() - tEffectsStart,
  )

  // Validate unit consistency and motion semantics (warning-only; throws on hard invariants)
  validateMotionUnitsAndSemantics({
    config,
    finishLine,
    basePaths,
    finalMatrix: finalHorseStateMatrix,
    ticks,
  })

  // Winner from canonical matrix (keeps acceptance criteria aligned)
  const winnerFromMatrix =
    determineWinner(finalHorseStateMatrix, finishLine, config.dtMs)?.horseId ||
    winnerId

  // Crossing times derived from canonical matrix
  const crossings = computeCrossingsFromMatrix(
    finalHorseStateMatrix,
    finishLine,
    config.dtMs,
  )

  // Deep-freeze stable outputs
  const frozenTicks = deepFreezeTicks(ticks)
  const frozenFinishOrder = Object.freeze(finishOrder)
  const frozenFinishTimes = Object.freeze({ ...crossings.timesMs })
  const tFreezeStart = performance.now()
  const frozenTimeline = freezeEventTimeline(eventTimeline)
  engineMetrics.recordPrecomputePhase(
    'freeze',
    performance.now() - tFreezeStart,
  )

  precomputed = {
    id: raceId,
    config,
    horses,
    ticks: frozenTicks as unknown as PrecomputedTick[],
    finishLine,
    seedInt: seedInt,
    winnerId: winnerFromMatrix,
    finishOrder: frozenFinishOrder as unknown as string[],
    finishTimesMs: frozenFinishTimes,
    // New
    finishTickIndex: crossings.tickIndexByHorse,
    // Canonical artifacts
    eventTimeline: frozenTimeline,
    finalHorseStateMatrix,
  }

  // Compute checksum and attach
  try {
    const checksum = computeRaceChecksum(precomputed!)
    precomputed!.checksum = checksum
    log(`[${ts()}][RACE][${raceId}] checksum=${checksum}`)
  } catch {
    // non-fatal
  }

  lastStreamedIndex = null

  // Late-joiner: snapshot compact ticks for catch-up without touching engines or schedulers
  try {
    const catchupTicks = finalHorseStateMatrix.map((states, i) => ({
      tickIndex: i,
      positions: states.map((s) => s.position),
    }))
    activeRaces.set(raceId, {
      ticks: catchupTicks,
      startTime: 0,
      currentTickIndex: -1,
    })
  } catch {
    // no-op (non-fatal; additive only)
  }

  log(`[${ts()}][RACE][${raceId}] Seeded race`, {
    raceId,
    trackLength: config.trackLength,
    finishLine,
    durationMs: config.durationMs,
    dtMs: config.dtMs,
    winnerId,
  })

  return precomputed!
}

/**
 * Bind the real-world clock to the precomputed race and mark it active.
 * - Sets the race startTime, initializes currentRace runtime state for broadcasting.
 * - Emits a 'race:start' WebSocket message with initial horse info.
 * - Returns the same PrecomputedRace with startTime stamped.
 */
const DETERMINISTIC_CYCLE_START_MS = 30000
export function startPrecomputedRace(
  startTime = new Date(DETERMINISTIC_CYCLE_START_MS),
): PrecomputedRace {
  const sm = RaceState.getStateMachine()
  // Before starting: must be in "race_starting"
  if (!sm.is('race_starting')) {
    return precomputed!
  }

  if (!precomputed) {
    precomputed = seedPrecomputedRace()
  }
  precomputed.startTime = startTime
  // Transition into running
  sm.transition('race_running')

  log(
    `[${ts()}][RACE][${
      precomputed.id
    }] Race started at ${startTime.toISOString()}`,
  )

  currentRace = {
    id: precomputed.id,
    horses: precomputed.horses.map((h) => ({
      id: h.id,
      name: h.name,
      position: 0,
      minSpeed: h.baseSpeed,
      maxSpeed: h.baseSpeed,
    })),
    isActive: true,
    placements: [],
    winner: undefined,
    lastBroadcastedTick: -1,
  }

  RaceWebSocketServer.broadcast({
    type: 'race:start',
    data: { raceId: precomputed.id, horses: currentRace.horses },
  })
  return precomputed
}

// Helper: enforce sequential tick broadcasting and dedupe
function broadcastTickSafe(
  runtimeRace: Race,
  tickIndex: number,
  updates: PositionUpdate[],
) {
  if (tickIndex <= runtimeRace.lastBroadcastedTick) {
    log(
      `[${ts()}][TICK][${
        runtimeRace.id
      }] Dropping duplicate/old tick idx=${tickIndex} last=${
        runtimeRace.lastBroadcastedTick
      }`,
    )
    return
  }
  if (tickIndex > runtimeRace.lastBroadcastedTick + 1) {
    const skipped = tickIndex - runtimeRace.lastBroadcastedTick - 1
    log(
      `[${ts()}][TICK][${runtimeRace.id}] Skipping ${skipped} ticks (last=${
        runtimeRace.lastBroadcastedTick
      }, now=${tickIndex})`,
    )
  }
  RaceWebSocketServer.broadcast({
    type: 'race:tick',
    data: updates,
  })
  runtimeRace.lastBroadcastedTick = tickIndex
}

/**
 * Stream the current tick to clients based on real-world elapsed time.
 * - Computes elapsed since startTime, finds closest precomputed tick by timestamp.
 * - Broadcasts 'race:tick' with per-horse positions.
 * - When duration ends, finalizes the race and emits 'race:finish'.
 * - Returns the PositionUpdate[] for the current tick.
 */
export function streamPrecomputedTicks(now = new Date()): PositionUpdate[] {
  const sm = RaceState.getStateMachine()
  // Before broadcasting ticks: must be in "race_running"
  if (!sm.is('race_running')) return []

  if (!precomputed?.startTime || !currentRace?.isActive) {
    throw new Error('No active precomputed race')
  }
  const elapsedMs = now.getTime() - precomputed.startTime.getTime()
  const idx = closestTickIndexByMatrix(
    precomputed.finalHorseStateMatrix ?? [],
    elapsedMs,
    precomputed.config.dtMs,
  )
  const driftMs = elapsedMs - idx * precomputed.config.dtMs

  // Sync/drift logs
  if (Math.abs(driftMs) > precomputed.config.dtMs / 2) {
    log(
      `[${ts()}][SYNC][${
        precomputed.id
      }] Drift=${driftMs}ms (elapsed=${elapsedMs}ms, tickTs=${
        idx * precomputed.config.dtMs
      }ms)`,
    )
  }
  if (lastStreamedIndex !== null && idx - lastStreamedIndex > 1) {
    const skipped = idx - lastStreamedIndex - 1
    log(
      `[${ts()}][SYNC][${
        precomputed.id
      }] Skipped ${skipped} intermediate ticks (last=${lastStreamedIndex}, now=${idx})`,
    )
  }
  lastStreamedIndex = idx

  const states = precomputed.finalHorseStateMatrix?.[idx]
  const updates: PositionUpdate[] = (states ?? []).map((s) => ({
    horseId: s.horseId,
    position: s.position,
  }))

  log(
    `[${ts()}][TICK][${
      precomputed.id
    }] Stream tick index=${idx} elapsed=${elapsedMs}ms`,
  )

  // Sequential guard broadcast
  if (currentRace) {
    broadcastTickSafe(currentRace, idx, updates)
  }
  consecutiveTickFailures = 0

  const raceDurationOver = elapsedMs >= precomputed.config.durationMs
  const winnerId = precomputed.winnerId
  if (raceDurationOver && winnerId && currentRace.isActive) {
    // Before ending
    sm.transition('race_finished')

    currentRace.isActive = false
    currentRace.placements = precomputed.finishOrder.map((id) => {
      const h = currentRace!.horses.find((hh) => hh.id === id)!
      return h
    })
    currentRace.winner = currentRace.placements[0]
    precomputed.endTime = now

    log(`[${ts()}][RACE][${precomputed.id}] Race finished. Winner=${winnerId}`)

    // Persist canonical artifacts
    persistCompletedRace(precomputed)

    RaceWebSocketServer.broadcast({
      type: 'race:finish',
      data: { winner: currentRace.winner!, placements: currentRace.placements },
    })
  }

  return updates
}

/**
 * Utility to find the closest precomputed tick index for a given elapsed time.
 * - Performs a simple linear search over ticks to minimize timestamp difference.
 * - Returns the index of the best matching tick for synchronization.
 */
function closestTickIndex(ticks: PrecomputedTick[], elapsedMs: number): number {
  // linear search is fine for ~400 frames
  let bestIdx = 0
  let bestDiff = Math.abs(elapsedMs - ticks[0].timestampOffsetMs)
  for (let i = 1; i < ticks.length; i++) {
    const d = Math.abs(elapsedMs - ticks[i].timestampOffsetMs)
    if (d < bestDiff) {
      bestIdx = i
      bestDiff = d
    }
  }
  return bestIdx
}

// Closest index helper using canonical matrix timing
function closestTickIndexByMatrix(
  matrix: FinalHorseStateMatrix,
  elapsedMs: number,
  dtMs: number,
): number {
  if (!matrix || matrix.length === 0) return 0
  const idx = Math.round(elapsedMs / dtMs)
  return Math.max(0, Math.min(idx, matrix.length - 1))
}
// Deep-freeze precomputed ticks to prevent mutation
function deepFreezeTicks(
  ticks: PrecomputedTick[],
): ReadonlyArray<Readonly<PrecomputedTick>> {
  for (let i = 0; i < ticks.length; i++) {
    const t = ticks[i]
    for (let j = 0; j < t.positions.length; j++) {
      const p = t.positions[j]
      Object.freeze(p)
    }
    Object.freeze(t.positions)
    Object.freeze(t)
  }
  return Object.freeze(ticks)
}

// Immutable proxy wrapper to prevent timeline mutations (set/delete/clear)
function freezeEventTimeline(tl: EventTimeline): EventTimeline {
  const target = tl as Map<number, ReadonlyArray<any>>
  const immutable = new Proxy(target, {
    get(obj, prop, receiver) {
      if (prop === 'set' || prop === 'delete' || prop === 'clear') {
        return () => {
          throw new Error('EventTimeline is immutable')
        }
      }
      const val = Reflect.get(obj, prop, receiver)
      return typeof val === 'function' ? val.bind(obj) : val
    },
  }) as unknown as EventTimeline
  return immutable
}

// Build base horse paths from precomputed ticks (deterministic; lanes by index)
function buildBaseHorsePaths(
  horses: HorseSeed[],
  ticks: PrecomputedTick[],
  config: RaceConfig,
): ReadonlyArray<ReadonlyArray<HorseBaseTick>> {
  const dtSec = config.dtMs / 1000
  const byIdOrder = horses.map((h) => h.id)
  const positionsByTick: Map<number, Map<string, number>> = new Map()
  for (let i = 0; i < ticks.length; i++) {
    const m = new Map<string, number>()
    for (const p of ticks[i].positions) m.set(p.horseId, p.distance)
    positionsByTick.set(i, m)
  }
  const out: HorseBaseTick[][] = new Array(ticks.length)
  for (let t = 0; t < ticks.length; t++) {
    const arr: HorseBaseTick[] = new Array(byIdOrder.length)
    for (let hIdx = 0; hIdx < byIdOrder.length; hIdx++) {
      const horseId = byIdOrder[hIdx]
      const pos = positionsByTick.get(t)?.get(horseId) ?? 0
      const prevPos =
        positionsByTick.get(Math.max(0, t - 1))?.get(horseId) ?? pos
      const speed = Math.max(0, (pos - prevPos) / dtSec)
      arr[hIdx] = {
        horseId,
        position: pos,
        lane: hIdx,
        speed,
      }
    }
    Object.freeze(arr)
    out[t] = arr
  }
  return Object.freeze(out)
}

// Compute crossing times (ms) and tick index per horse from canonical matrix
function computeCrossingsFromMatrix(
  matrix: FinalHorseStateMatrix,
  finishDistance: number,
  dtMs: number,
): {
  timesMs: Record<string, number>
  tickIndexByHorse: Record<string, number>
} {
  const times: Record<string, number> = {}
  const idxByHorse: Record<string, number> = {}
  if (!matrix || matrix.length === 0)
    return { timesMs: times, tickIndexByHorse: idxByHorse }
  for (let t = 0; t < matrix.length; t++) {
    for (const s of matrix[t]) {
      if (times[s.horseId] != null) continue
      if (s.position >= finishDistance && !s.isRemoved) {
        times[s.horseId] = t * dtMs
        idxByHorse[s.horseId] = t
      }
    }
  }
  return { timesMs: times, tickIndexByHorse: idxByHorse }
}

// Validation for unit consistency and motion semantics
function validateMotionUnitsAndSemantics(args: {
  config: RaceConfig
  finishLine: number
  basePaths: ReadonlyArray<ReadonlyArray<HorseBaseTick>>
  finalMatrix: FinalHorseStateMatrix
  ticks: PrecomputedTick[]
}): void {
  const { config, finishLine, basePaths, finalMatrix, ticks } = args
  const expectedTicks = Math.floor(config.durationMs / config.dtMs) + 1
  const lenMismatch =
    ticks.length !== expectedTicks || finalMatrix.length !== expectedTicks
  if (lenMismatch) {
    console.warn(
      `[${ts()}][UNITS] Tick length mismatch: expected=${expectedTicks} pre=${ticks.length} final=${finalMatrix.length}`,
    )
  }

  // Hard invariants: positions within [0, finishLine]
  for (let t = 0; t < finalMatrix.length; t++) {
    const states = finalMatrix[t]
    for (const s of states) {
      if (s.position < -1e-9) {
        throw new Error(
          `Negative position detected at tick=${t} horse=${s.horseId}`,
        )
      }
      if (s.position > finishLine + 1e-9) {
        throw new Error(
          `Overshoot beyond finishLine at tick=${t} horse=${s.horseId}`,
        )
      }
    }
  }

  // Stun semantics: when stunned and not starting an instantaneous offset, movement halts
  const INSTANT_IDS = new Set(['hook_shot', 'rocket_boost'])
  for (let t = 1; t < finalMatrix.length; t++) {
    const prev = finalMatrix[t - 1]
    const cur = finalMatrix[t]
    for (let i = 0; i < cur.length; i++) {
      const c = cur[i]
      const p = prev[i]
      if (!c || !p) continue
      if (c.isStunned && !c.isRemoved) {
        const hadInstantStart = c.activeEvents.some((id) => {
          const prevHad = p.activeEvents.includes(id)
          return INSTANT_IDS.has(id) && !prevHad
        })
        if (!hadInstantStart) {
          const delta = c.position - p.position
          if (delta > 1e-9) {
            console.warn(
              `[${ts()}][SEMANTICS] Stunned movement > 0 at tick=${t} horse=${c.horseId} delta=${delta.toFixed(3)}`,
            )
          }
        }
      }
    }
  }

  // Unit summary (auditable)
  log(
    `[${ts()}][UNITS] Track=${config.trackLength}m finishLine=${finishLine}m dtMs=${config.dtMs} durationMs=${config.durationMs} ticks=${finalMatrix.length}`,
  )
}

/**
 * Stream a specific precomputed tick by index (authoritative tick clock).
 * - Uses engine-provided tickIndex to select precomputed positions.
 * - Broadcasts sequentially; finishes when last tick reached.
 * - No Date.now usage; derives endTime from startTime + tick timestamp offset.
 */
export function streamPrecomputedTickAt(tickIndex: number): PositionUpdate[] {
  if (!precomputed || !currentRace) {
    throw new Error('No active precomputed race')
  }

  const idx = Math.max(
    0,
    Math.min(
      tickIndex,
      (precomputed.finalHorseStateMatrix?.length ?? precomputed.ticks.length) -
        1,
    ),
  )
  const states = precomputed.finalHorseStateMatrix?.[idx]
  const updates: PositionUpdate[] = (states ?? []).map((s) => ({
    horseId: s.horseId,
    position: s.position,
  }))

  // Sequential guard broadcast
  broadcastTickSafe(currentRace, idx, updates)

  // Update authoritative current tick for catch-up consumers
  const rec = activeRaces.get(precomputed.id)
  if (rec) {
    rec.currentTickIndex = idx
    activeRaces.set(precomputed.id, rec)
  }

  // Finish when last tick reached
  const isLast =
    idx >=
    (precomputed.finalHorseStateMatrix?.length ?? precomputed.ticks.length) - 1
  if (isLast && currentRace.isActive) {
    currentRace.isActive = false
    currentRace.placements = precomputed.finishOrder.map((id) => {
      const h = currentRace!.horses.find((hh) => hh.id === id)!
      return h
    })
    currentRace.winner = currentRace.placements[0]
    if (precomputed.startTime) {
      const endOffset = precomputed.config.durationMs
      precomputed.endTime = new Date(
        precomputed.startTime.getTime() + endOffset,
      )
    }

    // Persist canonical artifacts
    persistCompletedRace(precomputed)

    RaceWebSocketServer.broadcast({
      type: 'race:finish',
      data: { winner: currentRace.winner!, placements: currentRace.placements },
    })
  }

  return updates
}
