// Minimal, isolated state for late-joiner catch-up.
export const TICK_MS = 50

// Local RaceTick type for catch-up snapshots
export interface RaceTick {
  tickIndex: number
  positions: number[]
}

export const activeRaces = new Map<
  string,
  { ticks: RaceTick[]; startTime: number; currentTickIndex: number }
>()
