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
  raceId: string
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
  raceId: string
  finishOrder: string[]
  finishTimes: Record<string, number> // seconds
}

/**
 * Complete race data
 */
export interface Race {
  id: string
  horses: Horse[]
  isActive: boolean
  winner?: Horse
  placements: Horse[]
}

/**
 * WebSocket message types
 */
export type WebSocketMessage =
  | { type: 'race:start'; data: { raceId: string; horses: Horse[] } }
  | { type: 'race:tick'; data: PositionUpdate[] }
  | { type: 'race:finish'; data: { winner: Horse; placements: Horse[] } }

export interface RaceConfig {
  trackLength: number
  finishRatio: number // e.g. 0.9 for 90%
  durationMs: number // e.g. 20000
  dtMs: number // e.g. 50
  seed: string // deterministic seed per race
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
  id: string
  config: RaceConfig
  horses: HorseSeed[]
  ticks: PrecomputedTick[]
  finishLine: number
  winnerId: string
  finishOrder: string[]
  finishTimesMs: Record<string, number>
  startTime?: Date
  endTime?: Date
}
