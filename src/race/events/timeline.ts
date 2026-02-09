import { makeMulberry32, hashStringToInt } from '../../race/rng.js'
import type { EventDefinition } from './catalog.js'

export type EventInstance = Readonly<{
  id: string
  tickIndex: number
  instanceId: string
}>

export type EventTimeline = ReadonlyMap<number, Readonly<EventInstance[]>>

// Configurable constant: minimum spacing between identical event ids (in ticks)
export const MIN_SPACING_TICKS = 15

// -------------------- Deterministic pacing model --------------------
export type RacePhaseId = 'early' | 'mid' | 'final'
export type RacePhase = Readonly<{
  id: RacePhaseId
  startTick: number
  endTick: number // inclusive
}>

// Weighting categories (map chaos/meta -> chaos)
type WeightCategory = 'powerup' | 'combat' | 'environmental' | 'chaos'
export type PhaseWeights = Readonly<Record<WeightCategory, number>>
export type PacingCurve = Readonly<Record<RacePhaseId, PhaseWeights>>

// Declarative, deterministic pacing curve
export const PACING_CURVE: PacingCurve = Object.freeze({
  early: Object.freeze({
    powerup: 3, // readable & buffs
    combat: 1, // low conflict early
    environmental: 1, // light noise
    chaos: 0, // intentionally disabled early
  }),
  mid: Object.freeze({
    powerup: 2, // still present
    combat: 2, // pressure increases
    environmental: 1, // occasional terrain
    chaos: 1, // begins to appear
  }),
  final: Object.freeze({
    powerup: 1, // some final boosts
    combat: 3, // high interaction
    environmental: 2, // meaningful hazards
    chaos: 3, // peak chaos (predictable ramp)
  }),
})

// -------------------- New: configurable phase percentages and ramp mode --------------------
export type PhasePercents = Readonly<{
  earlyEndPct: number // e.g., 0.30
  midEndPct: number // e.g., 0.70
}>
export type RampMode = 'none' | 'linear'

export type TimelineDebugEvent =
  | {
      type: 'candidate'
      tickIndex: number
      phase: RacePhaseId
      eventId: string
      category: WeightCategory
      weight: number
      normalizedScore: number
      reason?: undefined
    }
  | {
      type: 'skip-weight-zero'
      tickIndex: number
      phase: RacePhaseId
      eventId: string
      category: WeightCategory
      weight: 0
      normalizedScore: 0
      reason: 'weight-zero'
    }

export type GenerateTimelineOptions = Readonly<{
  pacingCurve?: PacingCurve
  phasePercents?: PhasePercents
  rampMode?: RampMode
  debug?: {
    logger?: (e: TimelineDebugEvent) => void
  }
}>

const DEFAULT_PHASE_PERCENTS: PhasePercents = Object.freeze({
  earlyEndPct: 0.3,
  midEndPct: 0.7,
})

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n))
}

// Compute deterministic phase ranges from duration (with configurable percent boundaries)
export function getRacePhases(
  raceDurationTicks: number,
  percents: PhasePercents = DEFAULT_PHASE_PERCENTS
): Readonly<RacePhase[]> {
  const total = Math.max(1, raceDurationTicks)
  const ePct = clamp01(percents.earlyEndPct)
  const mPct = clamp01(percents.midEndPct)
  const earlyEnd = Math.max(0, Math.floor(total * ePct) - 1)
  const midEnd = Math.max(earlyEnd, Math.floor(total * mPct) - 1)
  const finalEnd = total - 1
  const phases: RacePhase[] = [
    { id: 'early', startTick: 0, endTick: earlyEnd },
    { id: 'mid', startTick: earlyEnd + 1, endTick: midEnd },
    { id: 'final', startTick: midEnd + 1, endTick: finalEnd },
  ]
  return Object.freeze(phases.map((p) => Object.freeze(p)))
}

export function getRacePhaseForTick(
  tick: number,
  raceDurationTicks: number,
  percents: PhasePercents = DEFAULT_PHASE_PERCENTS
): RacePhaseId {
  const phases = getRacePhases(raceDurationTicks, percents)
  const clamped = Math.max(0, Math.min(tick, raceDurationTicks - 1))
  const found = phases.find(
    (p) => clamped >= p.startTick && clamped <= p.endTick
  )
  return (found?.id ?? 'final') as RacePhaseId
}

export function getPhaseWeightsForTick(
  tick: number,
  raceDurationTicks: number,
  pacingCurve: PacingCurve = PACING_CURVE,
  percents: PhasePercents = DEFAULT_PHASE_PERCENTS,
  rampMode: RampMode = 'none'
): PhaseWeights {
  const phases = getRacePhases(raceDurationTicks, percents)
  const clamped = Math.max(0, Math.min(tick, raceDurationTicks - 1))
  const idx = phases.findIndex(
    (p) => clamped >= p.startTick && clamped <= p.endTick
  )
  if (idx < 0) return pacingCurve.final

  const phase = phases[idx]
  if (rampMode === 'none') {
    return pacingCurve[phase.id]
  }

  // rampMode === 'linear' → blend weights towards next phase within the current phase window
  const next = phases[idx + 1]
  const thisW = pacingCurve[phase.id]
  if (!next) return thisW
  const nextW = pacingCurve[next.id]

  const span = Math.max(1, phase.endTick - phase.startTick + 1)
  const t = (clamped - phase.startTick) / span // 0..1 within phase
  const lerp = (a: number, b: number, tt: number) => a + (b - a) * tt

  const blended: PhaseWeights = Object.freeze({
    powerup: lerp(thisW.powerup, nextW.powerup, t),
    combat: lerp(thisW.combat, nextW.combat, t),
    environmental: lerp(thisW.environmental, nextW.environmental, t),
    chaos: lerp(thisW.chaos, nextW.chaos, t),
  })
  return blended
}

// Category normalization extensibility (map meta categories)
const CATEGORY_NORMALIZATION: Readonly<Record<string, WeightCategory>> =
  Object.freeze({
    'chaos/meta': 'chaos',
  })

function normalizeCategory(cat: EventDefinition['category']): WeightCategory {
  return (CATEGORY_NORMALIZATION[cat] ?? cat) as WeightCategory
}

function maxWeight(weights: PhaseWeights): number {
  return Math.max(
    weights.powerup,
    weights.combat,
    weights.environmental,
    weights.chaos
  )
}

function weightForCandidate(
  def: Readonly<EventDefinition>,
  tickIndex: number,
  raceDurationTicks: number,
  options?: GenerateTimelineOptions
): { weight: number; normalizedScore: number; phase: RacePhaseId } {
  const curve = options?.pacingCurve ?? PACING_CURVE
  const perc = options?.phasePercents ?? DEFAULT_PHASE_PERCENTS
  const ramp = options?.rampMode ?? 'none'
  const weights = getPhaseWeightsForTick(
    tickIndex,
    raceDurationTicks,
    curve,
    perc,
    ramp
  )
  const phase = getRacePhaseForTick(tickIndex, raceDurationTicks, perc)
  const cat = normalizeCategory(def.category)
  const w = weights[cat]
  const maxW = maxWeight(weights) || 1
  const normalizedScore = w <= 0 ? 0 : w / maxW
  return { weight: w, normalizedScore, phase }
}

// -------------------- Visualization helper --------------------
// Returns per-tick blended weights to visualize “chaos ramp”
export function getPerTickCategoryWeights(
  raceDurationTicks: number,
  options?: Readonly<{
    pacingCurve?: PacingCurve
    phasePercents?: PhasePercents
    rampMode?: RampMode
  }>
): ReadonlyArray<
  Readonly<{
    tick: number
    phase: RacePhaseId
    weights: PhaseWeights
  }>
> {
  const curve = options?.pacingCurve ?? PACING_CURVE
  const perc = options?.phasePercents ?? DEFAULT_PHASE_PERCENTS
  const ramp = options?.rampMode ?? 'none'
  const out: Array<{
    tick: number
    phase: RacePhaseId
    weights: PhaseWeights
  }> = []
  for (let t = 0; t < raceDurationTicks; t++) {
    const weights = getPhaseWeightsForTick(
      t,
      raceDurationTicks,
      curve,
      perc,
      ramp
    )
    const phase = getRacePhaseForTick(t, raceDurationTicks, perc)
    out.push({ tick: t, phase, weights })
  }
  return Object.freeze(
    out.map((e) =>
      Object.freeze({ ...e, weights: Object.freeze({ ...e.weights }) })
    )
  )
}

// -------------------- Candidate/placement model --------------------
type Candidate = {
  id: string
  tickIndex: number
  order: number
  occ: number
  def: Readonly<EventDefinition>
  weight: number // pacing weight for biasing placement
  normalizedScore: number // 0..1 within phase for debug
  phase: RacePhaseId
}

/**
 * Generate a deterministic timeline of events for a race.
 * - Uses only the provided seed (Mulberry32).
 * - Enforces per-event constraints and conflicts.
 * - Produces an immutable ReadonlyMap keyed by tickIndex.
 * - Integrates deterministic pacing curves to bias which events survive placement.
 */
export function generateEventTimeline(
  raceSeed: number,
  raceDurationTicks: number,
  catalog: Readonly<EventDefinition[]>,
  options?: GenerateTimelineOptions
): EventTimeline {
  const rng = makeMulberry32(raceSeed >>> 0)

  // 1) Build candidates deterministically (bounded; no retries)
  const candidates: Candidate[] = []
  let seq = 0
  for (const def of catalog) {
    const occMax = Math.max(0, Math.floor(def.maxOccurrencesPerRace))
    for (let occ = 0; occ < occMax; occ++) {
      const r = rng()
      const tickIndex = Math.min(
        raceDurationTicks - 1,
        Math.max(0, Math.floor(r * raceDurationTicks))
      )
      const w = weightForCandidate(def, tickIndex, raceDurationTicks, options)
      candidates.push({
        id: def.id,
        tickIndex,
        order: seq++,
        occ,
        def,
        weight: w.weight,
        normalizedScore: w.normalizedScore,
        phase: w.phase,
      })
    }
  }

  // 2) Sort by tickIndex, then by higher pacing weight, then by insertion order
  candidates.sort(
    (a, b) =>
      a.tickIndex - b.tickIndex || b.weight - a.weight || a.order - b.order
  )

  // 3) Place while enforcing constraints (spacing, concurrency, conflicts)
  const placed = new Map<number, EventInstance[]>()
  const lastPlacedById = new Map<string, number>()

  // Precompute a conflicts map for O(1) checks
  const conflictMap = new Map<string, ReadonlyArray<string>>()
  for (const def of catalog) conflictMap.set(def.id, def.conflictsWith)

  for (const c of candidates) {
    // Optional debug: weight-0 visualization
    if (c.weight <= 0) {
      options?.debug?.logger?.({
        type: 'skip-weight-zero',
        tickIndex: c.tickIndex,
        phase: c.phase,
        eventId: c.id,
        category: normalizeCategory(c.def.category),
        weight: 0,
        normalizedScore: 0,
        reason: 'weight-zero',
      })
      continue
    } else {
      // Optional per-candidate debug snapshot
      options?.debug?.logger?.({
        type: 'candidate',
        tickIndex: c.tickIndex,
        phase: c.phase,
        eventId: c.id,
        category: normalizeCategory(c.def.category),
        weight: c.weight,
        normalizedScore: c.normalizedScore,
      })
    }

    // Enforce min spacing
    const lastTick = lastPlacedById.get(c.id)
    if (lastTick !== undefined && c.tickIndex - lastTick < MIN_SPACING_TICKS) {
      continue
    }

    const atTick = placed.get(c.tickIndex) ?? []
    // Enforce maxConcurrent same id at this tick
    const sameIdCount = atTick.reduce(
      (acc, e) => (e.id === c.id ? acc + 1 : acc),
      0
    )
    if (sameIdCount >= c.def.maxConcurrent) continue

    // Conflicts at this tick (both directions)
    const conflict = atTick.some(
      (e) =>
        c.def.conflictsWith.includes(e.id) ||
        (conflictMap.get(e.id)?.includes(c.id) ?? false)
    )
    if (conflict) continue

    const instanceId = deterministicInstanceId(
      raceSeed,
      c.id,
      c.tickIndex,
      c.occ
    )
    const instance: EventInstance = Object.freeze({
      id: c.id,
      tickIndex: c.tickIndex,
      instanceId,
    })
    atTick.push(instance)
    placed.set(c.tickIndex, atTick)
    lastPlacedById.set(c.id, c.tickIndex)
  }

  // 4) Freeze arrays and return as ReadonlyMap, preserving tick order
  const out = new Map<number, Readonly<EventInstance[]>>()
  const sortedTicks = Array.from(placed.keys()).sort((a, b) => a - b)
  for (const tick of sortedTicks) {
    const arr = placed.get(tick)!
    out.set(tick, Object.freeze([...arr]))
  }
  return out as EventTimeline
}

function deterministicInstanceId(
  seed: number,
  eventId: string,
  tickIndex: number,
  occ: number
): string {
  const key = `${seed}|${eventId}|${tickIndex}|${occ}`
  const h = hashStringToInt(key) >>> 0
  const hex = h.toString(16).padStart(8, '0')
  return `evt-${hex}`
}

function getConflictsFor(
  catalog: Readonly<EventDefinition[]>,
  id: string
): ReadonlyArray<string> | undefined {
  const def = catalog.find((e) => e.id === id)
  return def?.conflictsWith
}
