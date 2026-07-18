import { PrecomputedRace, Race } from './raceTypes.js'
import { RaceStateMachine } from './stateMachine.js'

import { hashStringToInt } from './rng.js'
import { getRaceHistoryLimit } from '../observability/raceAuthorityStoragePolicy.js'
const ts = () => new Date().toISOString()

/**
 * Structured logging helpers
 */
type TickHorsePos = { horseId: string; distance: number }
type TickSummary = {
  index: number
  timestampOffsetMs: number
  elapsedMs: number
  horses: TickHorsePos[]
}

type PrecomputeSummaryArgs = {
  raceRef: string
  tickCount: number
  first3: TickSummary[]
  last3: TickSummary[]
  projectedWinnerId: string
}

type RaceScheduleArgs = {
  raceRef: string
  trackLength: number
  finishLine: number
  durationMs: number
  dtMs: number
  winnerId?: string | null
}

type CountdownArgs = { raceRef: string; tMinusSec: number }
type RaceStartArgs = { raceRef: string; timestamp: string }
type RaceFinishArgs = { raceRef: string; timestamp: string; winnerId: string }
type RaceArchiveArgs = { raceRef: string; durationMs: number }

type TickStreamArgs = {
  raceRef: string
  tick: TickSummary
  broadcastCount: number
}
type TickSkippedArgs = { raceRef: string; skippedCount: number; reason?: string }
type DebugVelocityArgs = {
  raceRef: string
  tickIndex: number
  velocities: { horseId: string; velocity: number }[]
}
type DebugSeedArgs = { raceRef: string }
type DebugDriftArgs = {
  raceRef: string
  tickIndex: number
  driftMs: number
  correctionAppliedMs: number
}

const fmt = (category: string, raceRef?: string) =>
  `[${ts()}][${category}]${raceRef ? `[${raceRef}]` : ''}`

const isDev =
  process.env.NODE_ENV === 'development' ||
  process.env.DEBUG === '1' ||
  process.env.LOG_DEV === '1'

export const Log = {
  serverStart() {
    console.log(`${fmt('SERVER')} Server starting`)
  },
  wsReady(clientCount?: number) {
    console.log(
      `${fmt('WS')} WebSocket ready${
        clientCount !== undefined ? ` (clients=${clientCount})` : ''
      }`,
    )
  },
  raceScheduled(args: RaceScheduleArgs) {
    const {
      raceRef,
      trackLength,
      finishLine,
      durationMs,
      dtMs,
      winnerId,
    } = args
    console.log(
      `${fmt('RACE', raceRef)} Scheduled/seeded ` +
        JSON.stringify({
          trackLength,
          finishLine,
          durationMs,
          dtMs,
          winnerId: winnerId ?? null,
        }),
    )
  },
  countdown({ raceRef, tMinusSec }: CountdownArgs) {
    console.log(`${fmt('COUNTDOWN', raceRef)} T-${tMinusSec}s`)
  },
  raceStart({ raceRef, timestamp }: RaceStartArgs) {
    console.log(`${fmt('START', raceRef)} at ${timestamp}`)
  },
  raceFinish({ raceRef, timestamp, winnerId }: RaceFinishArgs) {
    console.log(`${fmt('FINISH', raceRef)} at ${timestamp} winner=${winnerId}`)
  },
  raceArchive({ raceRef, durationMs }: RaceArchiveArgs) {
    console.log(`${fmt('ARCHIVE', raceRef)} durationMs=${durationMs}`)
  },
  precomputeSummary({
    raceRef,
    tickCount,
    first3,
    last3,
    projectedWinnerId,
  }: PrecomputeSummaryArgs) {
    console.log(
      `${fmt(
        'PRECOMPUTE',
        raceRef,
      )} tickCount=${tickCount} projectedWinner=${projectedWinnerId}`,
    )
    const serializeTick = (t: TickSummary) => ({
      idx: t.index,
      offsetMs: t.timestampOffsetMs,
      horses: t.horses.map((h) => `${h.horseId}:${h.distance}`),
    })
    console.log(
      `${fmt('PRECOMPUTE', raceRef)} first3=` +
        JSON.stringify(first3.map(serializeTick)),
    )
    console.log(
      `${fmt('PRECOMPUTE', raceRef)} last3=` +
        JSON.stringify(last3.map(serializeTick)),
    )
  },
  tickStream({ raceRef, tick, broadcastCount }: TickStreamArgs) {
    console.log(
      `${fmt('TICK', raceRef)} idx=${tick.index} elapsedMs=${
        tick.elapsedMs
      } offsetMs=${tick.timestampOffsetMs} ` +
        `horses=` +
        JSON.stringify(tick.horses) +
        ` broadcast=${broadcastCount}`,
    )
  },
  tickSkipped({ raceRef, skippedCount, reason }: TickSkippedArgs) {
    console.log(
      `${fmt('TICK-SKIP', raceRef)} count=${skippedCount}` +
        (reason ? ` reason=${reason}` : ''),
    )
  },
  broadcastInfo(raceRef: string, count: number) {
    console.log(`${fmt('WS', raceRef)} broadcast=${count}`)
  },
  // Debug-only logs
  debugVelocity({ raceRef, tickIndex, velocities }: DebugVelocityArgs) {
    if (!isDev) return
    console.log(
      `${fmt('DEBUG-VEL', raceRef)} idx=${tickIndex} ` +
        JSON.stringify(
          velocities.map((v) => ({ h: v.horseId, vel: v.velocity })),
        ),
    )
  },
  debugSeed({ raceRef }: DebugSeedArgs) {
    if (!isDev) return
    console.log(`${fmt('DEBUG-SEED', raceRef)} private seed initialized`)
  },
  debugDrift({
    raceRef,
    tickIndex,
    driftMs,
    correctionAppliedMs,
  }: DebugDriftArgs) {
    if (!isDev) return
    console.log(
      `${fmt(
        'DEBUG-DRIFT',
        raceRef,
      )} idx=${tickIndex} driftMs=${driftMs} correctionMs=${correctionAppliedMs}`,
    )
  },
}

/**
 * Global race state stored in memory
 */
export class RaceState {
  private static currentRace: Race | null = null
  private static precomputed: PrecomputedRace | null = null
  private static previousRace: PrecomputedRace | null = null
  private static history: PrecomputedRace[] = []
  private static stateMachine = new RaceStateMachine()
  private static currentSeed: string | null = null
  private static currentSeedInt: number | null = null
  private static cycleCounter = 0

  /**
   * Get the currently running race
   */
  static getCurrentRace(): Race | null {
    return this.currentRace
  }

  /**
   * Set the current race
   */
  static setCurrentRace(race: Race | null): void {
    this.currentRace = race
  }

  static getStateMachine(): RaceStateMachine {
    return this.stateMachine
  }

  static setPrecomputedRace(r: PrecomputedRace | null): void {
    this.precomputed = r
  }
  static getPrecomputedRace(): PrecomputedRace | null {
    return this.precomputed
  }

  // Seed lifecycle (available during countdown, racing, results; cleared on reset)
  static setCurrentSeed(seed: string | null): void {
    this.currentSeed = seed
    if (seed) {
      // Compute 32-bit int for RNG determinism
      this.currentSeedInt = hashStringToInt(seed)
      Log.debugSeed({ raceRef: this.precomputed?.raceRef ?? 'pending' })
    } else {
      this.currentSeedInt = null
    }
  }
  static getCurrentSeed(): string | null {
    return this.currentSeed
  }
  static getCurrentSeedInt(): number | null {
    return this.currentSeedInt
  }
  static clearCurrentSeed(): void {
    this.currentSeed = null
    this.currentSeedInt = null
  }

  // Cycle counter for deterministic per-cycle seed derivation
  static bumpCycle(): number {
    this.cycleCounter += 1
    return this.cycleCounter
  }
  static getCycleCounter(): number {
    return this.cycleCounter
  }

  /**
   * Complete a race and update state
   */
  static completeRace(): void {
    if (this.precomputed) {
      Log.raceArchive({
        raceRef: this.precomputed.raceRef,
        durationMs:
          // prefer explicit durationMs on precomputed, fall back to dt * ticks, or ticks length
          (this.precomputed as any).durationMs ??
          ((this.precomputed as any).dtMs &&
          (this.precomputed.ticks?.length ?? 0)
            ? (this.precomputed as any).dtMs * this.precomputed.ticks!.length
            : (this.precomputed.ticks?.length ?? 0)),
      })
      this.previousRace = this.precomputed
      this.history.unshift(this.precomputed)
      const historyLimit = getRaceHistoryLimit()
      if (this.history.length > historyLimit) {
        this.history = this.history.slice(0, historyLimit)
      }
      this.precomputed = null
    }
    this.currentRace = null
  }

  /**
   * Get race history (last 20 races)
   */
  static getHistory(): PrecomputedRace[] {
    return [...this.history]
  }

  /**
   * Get the previously completed race
   */
  static getPreviousRace(): PrecomputedRace | null {
    return this.previousRace
  }

  /**
   * Find a race by ID
   */
  static findPrecomputedById(raceId: string): PrecomputedRace | null {
    if (this.precomputed?.raceId === raceId) return this.precomputed
    if (this.previousRace?.raceId === raceId) return this.previousRace
    return this.history.find((race) => race.raceId === raceId) || null
  }

  static findPrecomputedByRef(raceRef: string): PrecomputedRace | null {
    const normalized = raceRef.toUpperCase()
    if (this.precomputed?.raceRef === normalized) return this.precomputed
    if (this.previousRace?.raceRef === normalized) return this.previousRace
    return this.history.find((race) => race.raceRef === normalized) || null
  }
}
