import { EventEmitter } from 'events'
import { RaceState } from './raceState.js'
import { activeRaces, TICK_MS } from './activeRaceMemory.js'
import { seedPrecomputedRace, startPrecomputedRace } from './raceEngine.js'

export type RacePhase =
  | 'idle'
  | 'countdown'
  | 'race_starting'
  | 'race_running'
  | 'race_finished'
  | 'results_showing'

const ALLOWED: Record<RacePhase, RacePhase[]> = {
  idle: ['countdown'],
  countdown: ['race_starting'],
  race_starting: ['race_running'],
  race_running: ['race_finished'],
  race_finished: ['results_showing'],
  results_showing: ['idle'],
}

// 60-second deterministic cycle mapping
// - idle: 0–26
// - countdown: 27–29
// - race_starting/race_running: 30–50
// - race_finished/results_showing: 51–59
const CYCLE_SECONDS = 60
const SECS = {
  idleStart: 0,
  idleEnd: 26,
  countdownStart: 27,
  countdownEnd: 29,
  raceStart: 30,
  raceEnd: 50,
  finishedStart: 51,
  finishedEnd: 59,
}

type Subscriber = (phase: RacePhase, second: number, data?: any) => void

export class RaceStateMachine {
  state: RacePhase = 'idle'
  private currentSecond = 0 // 0..59
  private events = new EventEmitter()

  transition(next: RacePhase): void {
    const allowed = ALLOWED[this.state]
    if (!allowed.includes(next)) {
      throw new Error(`Invalid transition: ${this.state} -> ${next}`)
    }
    this.state = next
    // Notify subscribers of explicit transitions
    this.events.emit('state', { phase: this.state, second: this.currentSecond })
  }

  is(state: RacePhase): boolean {
    return this.state === state
  }

  // Subscription to state changes and tick updates
  subscribe(fn: Subscriber): () => void {
    const handler = ({
      phase,
      second,
      data,
    }: {
      phase: RacePhase
      second: number
      data?: any
    }) => fn(phase, second, data)
    this.events.on('state', handler)
    this.events.on('tick', handler)
    // Immediately send current snapshot
    fn(this.state, this.currentSecond)
    return () => {
      this.events.off('state', handler)
      this.events.off('tick', handler)
    }
  }

  // Advance the cycle by 1 second (call every 1000ms)
  // Emits state changes at boundary seconds and per-second tick data during race_running.
  tick(): void {
    // Advance second
    this.currentSecond = (this.currentSecond + 1) % CYCLE_SECONDS

    // Determine phase by currentSecond and auto-transition as needed
    if (this.inRange(SECS.idleStart, SECS.idleEnd)) {
      // At 27s move to countdown
      if (this.currentSecond === SECS.countdownStart && this.state === 'idle') {
        // Deterministic per-cycle seed: cycle-<n>
        const cycleId = RaceState.bumpCycle()
        const seedStr = `cycle-${cycleId}`
        RaceState.setCurrentSeed(seedStr)
        this.transition('countdown')
        // Precompute race deterministically using single RNG instance
        const seeded = seedPrecomputedRace()
        RaceState.setPrecomputedRace(seeded)
      } else if (this.state !== 'idle' && this.currentSecond <= SECS.idleEnd) {
        // keep idle only when within range before countdown kicks in
        this.state = 'idle'
        this.events.emit('state', {
          phase: this.state,
          second: this.currentSecond,
        })
      }
    } else if (this.inRange(SECS.countdownStart, SECS.countdownEnd)) {
      if (this.state !== 'countdown') {
        this.transition('countdown')
      }
      // Countdown emits 3→2→1 for front-end convenience
      const tMinus = SECS.raceStart - this.currentSecond
      this.events.emit('tick', {
        phase: this.state,
        second: this.currentSecond,
        data: { countdown: tMinus }, // 3,2,1
      })
      // Transition to race_starting at 29→30 boundary
      if (this.currentSecond === SECS.countdownEnd) {
        this.transition('race_starting')
      }
    } else if (this.inRange(SECS.raceStart, SECS.raceEnd)) {
      // Start race exactly at 30s using the precomputed data
      if (
        this.currentSecond === SECS.raceStart &&
        this.state === 'race_starting'
      ) {
        startPrecomputedRace()
      }
      // Enter race_running right after race_starting boundary
      if (this.state === 'race_starting') {
        this.transition('race_running')
      } else if (this.state !== 'race_running') {
        // If externally set to race_running, keep consistent
        this.state = 'race_running'
        this.events.emit('state', {
          phase: this.state,
          second: this.currentSecond,
        })
      }
      // During race_running, emit per-second positions if available
      const pre = RaceState.getPrecomputedRace()
      if (pre?.id) {
        const rec = activeRaces.get(pre.id)
        if (rec) {
          const elapsed = (this.currentSecond - SECS.raceStart) * 1000 // ms since 30s
          const idx = Math.max(
            0,
            Math.min(Math.floor(elapsed / TICK_MS), rec.ticks.length - 1),
          )
          const positions = rec.ticks[idx]?.positions ?? []
          this.events.emit('tick', {
            phase: this.state,
            second: this.currentSecond,
            data: { tickIndex: idx, positions },
          })
        } else {
          this.events.emit('tick', {
            phase: this.state,
            second: this.currentSecond,
            data: { tickIndex: -1, positions: [] },
          })
        }
      } else {
        this.events.emit('tick', {
          phase: this.state,
          second: this.currentSecond,
          data: { tickIndex: -1, positions: [] },
        })
      }

      // Transition to race_finished at 51s
      if (this.currentSecond === SECS.finishedStart) {
        this.transition('race_finished')
      }
    } else if (this.inRange(SECS.finishedStart, SECS.finishedEnd)) {
      if (this.state === 'race_finished') {
        // Immediately enter results_showing (guarded transition)
        this.transition('results_showing')
      } else if (this.state !== 'results_showing') {
        this.state = 'results_showing'
        this.events.emit('state', {
          phase: this.state,
          second: this.currentSecond,
        })
      }
      // Optional per-second results updates
      this.events.emit('tick', {
        phase: this.state,
        second: this.currentSecond,
        data: { resultsVisible: true },
      })

      // Reset back to idle after 59s → next cycle
      if (this.currentSecond === SECS.finishedEnd) {
        this.transition('idle')
        // Clear seed on reset for next cycle
        RaceState.clearCurrentSeed()
        this.currentSecond = -1
      }
    }
  }

  // Helper: Remaining seconds in the current mapped state window
  getRemainingSecondsInState(): number {
    if (this.state === 'idle') return SECS.idleEnd - this.currentSecond
    if (this.state === 'countdown')
      return SECS.countdownEnd - this.currentSecond
    if (this.state === 'race_starting')
      return SECS.raceStart - this.currentSecond
    if (this.state === 'race_running')
      return SECS.finishedStart - this.currentSecond
    if (this.state === 'race_finished')
      return SECS.finishedEnd - this.currentSecond
    if (this.state === 'results_showing')
      return SECS.finishedEnd - this.currentSecond
    return 0
  }

  // Helper: Query current phase and second (for tests/UI)
  getPhaseAndSecond(): { phase: RacePhase; second: number } {
    return { phase: this.state, second: this.currentSecond }
  }

  private inRange(start: number, end: number): boolean {
    return this.currentSecond >= start && this.currentSecond <= end
  }
}
