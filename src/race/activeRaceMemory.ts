import type { LiveHorseEffect, LiveRaceEvent } from './raceTypes.js'

// Minimal, isolated state for late-joiner catch-up.
export const TICK_MS = 50

// Local RaceTick type for catch-up snapshots
export interface RaceTick {
  tickIndex: number
  positions: number[]
  events?: LiveRaceEvent[]
  effects?: LiveHorseEffect[]
  /** Optional sequencing (monotonic per raceId) captured at broadcast time */
  seq?: number
  /** Optional server-emission timestamp (ms since epoch) captured at broadcast time */
  tickTs?: number
}

export const activeRaces = new Map<
  string,
  {
    ticks: RaceTick[]
    startTime: number
    currentTickIndex: number
    winnerDeclaredSent: boolean
  }
>()
