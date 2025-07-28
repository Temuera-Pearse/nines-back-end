import { PrecomputedRace, Race } from './raceTypes.js'

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
  raceId: string
  tickCount: number
  first3: TickSummary[]
  last3: TickSummary[]
  projectedWinnerId: string
}

type RaceScheduleArgs = {
  raceId: string
  trackLength: number
  finishLine: number
  durationMs: number
  dtMs: number
  seed?: string
  winnerId?: string | null
}

type CountdownArgs = { raceId: string; tMinusSec: number }
type RaceStartArgs = { raceId: string; timestamp: string }
type RaceFinishArgs = { raceId: string; timestamp: string; winnerId: string }
type RaceArchiveArgs = { raceId: string; durationMs: number }

type TickStreamArgs = {
  raceId: string
  tick: TickSummary
  broadcastCount: number
}
type TickSkippedArgs = { raceId: string; skippedCount: number; reason?: string }
type DebugVelocityArgs = {
  raceId: string
  tickIndex: number
  velocities: { horseId: string; velocity: number }[]
}
type DebugSeedArgs = { raceId: string; seed: string }
type DebugDriftArgs = {
  raceId: string
  tickIndex: number
  driftMs: number
  correctionAppliedMs: number
}

const fmt = (category: string, raceId?: string) =>
  `[${ts()}][${category}]${raceId ? `[${raceId}]` : ''}`

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
      }`
    )
  },
  raceScheduled(args: RaceScheduleArgs) {
    const {
      raceId,
      trackLength,
      finishLine,
      durationMs,
      dtMs,
      seed,
      winnerId,
    } = args
    console.log(
      `${fmt('RACE', raceId)} Scheduled/seeded ` +
        JSON.stringify({
          trackLength,
          finishLine,
          durationMs,
          dtMs,
          seed,
          winnerId: winnerId ?? null,
        })
    )
  },
  countdown({ raceId, tMinusSec }: CountdownArgs) {
    console.log(`${fmt('COUNTDOWN', raceId)} T-${tMinusSec}s`)
  },
  raceStart({ raceId, timestamp }: RaceStartArgs) {
    console.log(`${fmt('START', raceId)} at ${timestamp}`)
  },
  raceFinish({ raceId, timestamp, winnerId }: RaceFinishArgs) {
    console.log(`${fmt('FINISH', raceId)} at ${timestamp} winner=${winnerId}`)
  },
  raceArchive({ raceId, durationMs }: RaceArchiveArgs) {
    console.log(`${fmt('ARCHIVE', raceId)} durationMs=${durationMs}`)
  },
  precomputeSummary({
    raceId,
    tickCount,
    first3,
    last3,
    projectedWinnerId,
  }: PrecomputeSummaryArgs) {
    console.log(
      `${fmt(
        'PRECOMPUTE',
        raceId
      )} tickCount=${tickCount} projectedWinner=${projectedWinnerId}`
    )
    const serializeTick = (t: TickSummary) => ({
      idx: t.index,
      offsetMs: t.timestampOffsetMs,
      horses: t.horses.map((h) => `${h.horseId}:${h.distance}`),
    })
    console.log(
      `${fmt('PRECOMPUTE', raceId)} first3=` +
        JSON.stringify(first3.map(serializeTick))
    )
    console.log(
      `${fmt('PRECOMPUTE', raceId)} last3=` +
        JSON.stringify(last3.map(serializeTick))
    )
  },
  tickStream({ raceId, tick, broadcastCount }: TickStreamArgs) {
    console.log(
      `${fmt('TICK', raceId)} idx=${tick.index} elapsedMs=${
        tick.elapsedMs
      } offsetMs=${tick.timestampOffsetMs} ` +
        `horses=` +
        JSON.stringify(tick.horses) +
        ` broadcast=${broadcastCount}`
    )
  },
  tickSkipped({ raceId, skippedCount, reason }: TickSkippedArgs) {
    console.log(
      `${fmt('TICK-SKIP', raceId)} count=${skippedCount}` +
        (reason ? ` reason=${reason}` : '')
    )
  },
  broadcastInfo(raceId: string, count: number) {
    console.log(`${fmt('WS', raceId)} broadcast=${count}`)
  },
  // Debug-only logs
  debugVelocity({ raceId, tickIndex, velocities }: DebugVelocityArgs) {
    if (!isDev) return
    console.log(
      `${fmt('DEBUG-VEL', raceId)} idx=${tickIndex} ` +
        JSON.stringify(
          velocities.map((v) => ({ h: v.horseId, vel: v.velocity }))
        )
    )
  },
  debugSeed({ raceId, seed }: DebugSeedArgs) {
    if (!isDev) return
    console.log(`${fmt('DEBUG-SEED', raceId)} seed=${seed}`)
  },
  debugDrift({
    raceId,
    tickIndex,
    driftMs,
    correctionAppliedMs,
  }: DebugDriftArgs) {
    if (!isDev) return
    console.log(
      `${fmt(
        'DEBUG-DRIFT',
        raceId
      )} idx=${tickIndex} driftMs=${driftMs} correctionMs=${correctionAppliedMs}`
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

  static setPrecomputedRace(r: PrecomputedRace | null): void {
    this.precomputed = r
  }
  static getPrecomputedRace(): PrecomputedRace | null {
    return this.precomputed
  }

  /**
   * Complete a race and update state
   */
  static completeRace(): void {
    if (this.precomputed) {
      Log.raceArchive({
        raceId: this.precomputed.id,
        durationMs:
          // prefer explicit durationMs on precomputed, fall back to dt * ticks, or ticks length
          (this.precomputed as any).durationMs ??
          ((this.precomputed as any).dtMs &&
          (this.precomputed.ticks?.length ?? 0)
            ? (this.precomputed as any).dtMs * this.precomputed.ticks!.length
            : this.precomputed.ticks?.length ?? 0),
      })
      this.previousRace = this.precomputed
      this.history.unshift(this.precomputed)
      if (this.history.length > 20) this.history = this.history.slice(0, 20)
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
  static findPrecomputedById(id: string): PrecomputedRace | null {
    if (this.precomputed?.id === id) return this.precomputed
    if (this.previousRace?.id === id) return this.previousRace
    return this.history.find((r) => r.id === id) || null
  }
}
