/**
 * Represents a horse in a race
 */
export interface Horse {
  id: string
  name: string
  position: number
  minSpeed: number
  maxSpeed: number
}

/**
 * Represents a single tick update during a race
 */
export interface RaceTick {
  raceRef: string
  tick: number
  horses: Array<{
    id: string
    distance: number // meters
  }>
}

/**
 * Final results of a completed race
 */
export interface RaceResult {
  raceRef: string
  finishOrder: string[]
  finishTimes: Record<string, number> // seconds
}

/**
 * Complete race data
 */
export interface Race {
  /** Private internal identity. Never serialize this object directly. */
  raceId: string
  horses: Horse[]
  isActive: boolean
  winner?: Horse
  placements: Horse[]
  lastBroadcastedTick: number
  /** Process-local durable completion gate; never serialized. */
  completionState?: 'persisting' | 'failed' | 'completed'
}

export interface LiveRaceEvent {
  id: string
  instanceId: string
  tickIndex: number
  affectedHorseIds: string[]
}

export interface LiveHorseEffect {
  horseId: string
  activeEventIds: string[]
  isStunned: boolean
  isRemoved: boolean
}

export interface RaceFinishPresentation {
  bannerVisibleUntilUtc: string
  resultsVisibleUntilUtc: string
}

export interface RaceFinishPayload {
  raceRef: string
  timestampUtc: string
  winnerId: string
  finishOrder: string[]
  finishTimesMs: Record<string, number>
  finishTickIndex: Record<string, number>
  presentation: RaceFinishPresentation
}

export interface RaceWinnerDeclaredPayload {
  raceRef: string
  timestampUtc: string
  winnerId: string
  finishOrder: string[]
  finishTimesMs: Record<string, number>
  finishTickIndex: Record<string, number>
  presentation: Pick<
    RaceFinishPresentation,
    'bannerVisibleUntilUtc' | 'resultsVisibleUntilUtc'
  >
}

export interface RaceFrameData {
  positions?: number[]
  deltas?: number[]
  events?: LiveRaceEvent[]
  effects?: LiveHorseEffect[]
}

/**
 * WebSocket message types
 */
export type WebSocketMessage =
  | {
      type: 'race:info'
      protoVer: number
      raceRef: string
      horseOrder: string[]
      config: RaceConfig
      currentTickIndex: number
      bettingOpensAt?: string
      bettingClosesAt?: string
      phase?: import('./stateMachine.js').RacePhase
    }
  | {
      type: 'race:start'
      protoVer?: number
      raceRef: string
      timestampUtc: string
      horseOrder: string[]
      horses: Array<{ id: string; name: string }>
    }
  | {
      type: 'race:tick' | 'race:keyframe' | 'race:delta'
      protoVer?: number
      raceRef: string
      seq?: number
      tickIndex: number
      tickTs?: number
      data: RaceFrameData
      sig?: string
      keyId?: string
    }
  | {
      type: 'race:winner-declared'
      protoVer?: number
      raceRef: string
      timestampUtc: string
      winnerId: string
      finishOrder: string[]
      finishTimesMs: Record<string, number>
      finishTickIndex: Record<string, number>
      presentation: Pick<
        RaceFinishPresentation,
        'bannerVisibleUntilUtc' | 'resultsVisibleUntilUtc'
      >
    }
  | {
      type: 'race:finish'
      protoVer?: number
      raceRef: string
      timestampUtc: string
      winnerId: string
      finishOrder: string[]
      finishTimesMs: Record<string, number>
      finishTickIndex: Record<string, number>
      presentation: RaceFinishPresentation
    }
  | {
      type: 'race:catchup'
      protoVer: number
      raceRef: string
      startIndex: number
      currentTickIndex: number
      ticks: Array<{
        type: 'race:tick'
        protoVer: number
        raceRef: string
        seq: number
        tickIndex: number
        tickTs: number
        data: RaceFrameData
      }>
    }
  | {
      type: 'race:sync-complete'
      protoVer: number
      raceRef: string
      currentTickIndex: number
    }
  | { type: 'error'; protoVer: number; message: string }

export interface RaceConfig {
  trackLength: number
  finishRatio: number // e.g. 0.9 for 90%
  durationMs: number // e.g. 20000
  dtMs: number // e.g. 50
  seed: string // PRIVATE: deterministic replay seed; strip from public payloads
}

export interface PositionUpdate {
  horseId: string
  position: number
}

export interface HorseSeed {
  id: string
  name: string
  baseSpeed: number // meters per second
  accelVariance: number // meters per second^2 variance
  rngSeed: number // per-horse seed
}

export interface PrecomputedTick {
  timestampOffsetMs: number
  positions: Array<{ horseId: string; distance: number }>
}

export interface PrecomputedRace {
  /** Private database/coordination identity. */
  raceId: string
  /** Public, non-derivable race reference. */
  raceRef: string
  /** Authoritative W2 wagering window when lifecycle delivery is enabled. */
  bettingOpensAt?: string
  bettingClosesAt?: string
  config: RaceConfig
  horses: HorseSeed[]
  ticks: PrecomputedTick[]
  finishLine: number
  /** Optional lineage for deterministic replay */
  seedInt?: number
  winnerId: string
  finishOrder: string[]
  finishTimesMs: Record<string, number>
  /** New: exact tick index at which each horse crosses the finish (floor of crossingMs/dtMs) */
  finishTickIndex: Record<string, number>
  authoritativeFinish?: RaceFinishPayload
  startTime?: Date
  endTime?: Date
  checksum?: string
  /** Canonical event timeline used by all consumers */
  eventTimeline?: import('./events/timeline.js').EventTimeline
  /** Canonical final horse state matrix (after applying all event effects) */
  finalHorseStateMatrix?: import('./events/effects.js').FinalHorseStateMatrix
}
