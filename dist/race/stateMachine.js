import { EventEmitter } from 'events';
import { RaceState } from './raceState.js';
import { activeRaces, TICK_MS } from './activeRaceMemory.js';
import { seedPrecomputedRace, startPrecomputedRace } from './raceEngine.js';
import { randomBytes } from 'crypto';
import { releaseRace } from './cleanup.js';
const ALLOWED = {
    idle: ['countdown'],
    countdown: ['race_starting'],
    race_starting: ['race_running'],
    race_running: ['race_finished'],
    race_finished: ['results_showing'],
    results_showing: ['idle'],
};
// 60-second deterministic cycle mapping
// - idle: 0–26
// - countdown: 27–29
// - race_starting/race_running: 30–50
// - race_finished/results_showing: 51–59
const CYCLE_SECONDS = 60;
const SECS = {
    idleStart: 0,
    idleEnd: 26,
    countdownStart: 27,
    countdownEnd: 29,
    raceStart: 30,
    raceEnd: 50,
    finishedStart: 51,
    finishedEnd: 59,
};
function nextSeedString(cycleId) {
    // Deterministic engine: same seed => same race.
    // This function controls *seed generation*, not determinism of the engine itself.
    const fixed = process.env.FIXED_SEED;
    if (fixed && fixed.trim())
        return fixed.trim();
    // Default to random seeds for real gameplay and local dev.
    // Use deterministic mode for reproducible debugging.
    const modeEnv = (process.env.SEED_MODE || '').toLowerCase();
    const isTest = process.env.NODE_ENV === 'test';
    const mode = isTest || modeEnv === 'deterministic' ? 'deterministic' : 'random';
    if (mode === 'deterministic')
        return `cycle-${cycleId}`;
    const nonce = randomBytes(6).toString('hex');
    return `cycle-${cycleId}-${nonce}`;
}
export class RaceStateMachine {
    state = 'idle';
    // currentSecond is always snapped to the actual UTC second — no accumulated drift.
    currentSecond = new Date().getUTCSeconds();
    // Deduplicate: track the last UTC second we processed to prevent double-advancing
    // when the aligned timer fires 1ms early and immediately reschedules.
    lastProcessedUTCSec = -1;
    events = new EventEmitter();
    transition(next) {
        const allowed = ALLOWED[this.state];
        if (!allowed.includes(next)) {
            throw new Error(`Invalid transition: ${this.state} -> ${next}`);
        }
        this.state = next;
        // Notify subscribers of explicit transitions
        this.events.emit('state', { phase: this.state, second: this.currentSecond });
    }
    is(state) {
        return this.state === state;
    }
    // Subscription to state changes and tick updates
    subscribe(fn) {
        const handler = ({ phase, second, data, }) => fn(phase, second, data);
        this.events.on('state', handler);
        this.events.on('tick', handler);
        // Immediately send current snapshot
        fn(this.state, this.currentSecond);
        return () => {
            this.events.off('state', handler);
            this.events.off('tick', handler);
        };
    }
    // Advance the cycle by 1 second (call every 1000ms)
    // Emits state changes at boundary seconds and per-second tick data during race_running.
    tick() {
        // Snap to actual UTC second — eliminates drift from timer jitter.
        const utcSec = new Date().getUTCSeconds();
        // Deduplicate: if the aligned timer fires 1ms early then again at the boundary,
        // ignore the second fire so currentSecond never double-advances.
        if (utcSec === this.lastProcessedUTCSec)
            return;
        this.lastProcessedUTCSec = utcSec;
        this.currentSecond = utcSec;
        // Determine phase by currentSecond and auto-transition as needed
        if (this.inRange(SECS.idleStart, SECS.idleEnd)) {
            // Ensure a precomputed race exists early in the cycle so /race/current is available.
            if (this.currentSecond === SECS.idleStart) {
                // Force a brand-new race every cycle.
                // If something went wrong in the prior cycle and a race is still hanging around,
                // clear it first so we never repeat the exact same race over and over.
                const existing = RaceState.getPrecomputedRace();
                if (existing?.id) {
                    try {
                        releaseRace(existing.id);
                    }
                    catch {
                        // best-effort
                    }
                }
                const cycleId = RaceState.bumpCycle();
                const seedStr = nextSeedString(cycleId);
                RaceState.setCurrentSeed(seedStr);
                const seeded = seedPrecomputedRace();
                RaceState.setPrecomputedRace(seeded);
            }
            if (this.state !== 'idle' && this.currentSecond <= SECS.idleEnd) {
                // keep idle only when within range before countdown kicks in
                this.state = 'idle';
                this.events.emit('state', {
                    phase: this.state,
                    second: this.currentSecond,
                });
            }
        }
        else if (this.inRange(SECS.countdownStart, SECS.countdownEnd)) {
            // Safety: if booted mid-cycle and no precomputed race exists yet, seed now.
            if (this.currentSecond === SECS.countdownStart) {
                const existing = RaceState.getPrecomputedRace();
                if (!existing) {
                    const cycleId = RaceState.bumpCycle();
                    const seedStr = nextSeedString(cycleId);
                    RaceState.setCurrentSeed(seedStr);
                    const seeded = seedPrecomputedRace();
                    RaceState.setPrecomputedRace(seeded);
                }
            }
            if (this.state !== 'countdown')
                this.transition('countdown');
            // Countdown emits 3→2→1 for front-end convenience
            const tMinus = SECS.raceStart - this.currentSecond;
            this.events.emit('tick', {
                phase: this.state,
                second: this.currentSecond,
                data: { countdown: tMinus }, // 3,2,1
            });
            // Transition to race_starting at 29→30 boundary
            if (this.currentSecond === SECS.countdownEnd) {
                this.transition('race_starting');
            }
        }
        else if (this.inRange(SECS.raceStart, SECS.raceEnd)) {
            // Start race exactly at 30s using the precomputed data
            if (this.currentSecond === SECS.raceStart &&
                this.state === 'race_starting') {
                startPrecomputedRace();
            }
            // Enter race_running right after race_starting boundary
            if (this.state === 'race_starting') {
                this.transition('race_running');
            }
            else if (this.state !== 'race_running') {
                // If externally set to race_running, keep consistent
                this.state = 'race_running';
                this.events.emit('state', {
                    phase: this.state,
                    second: this.currentSecond,
                });
            }
            // During race_running, emit per-second positions if available
            const pre = RaceState.getPrecomputedRace();
            if (pre?.id) {
                const rec = activeRaces.get(pre.id);
                if (rec) {
                    const elapsed = (this.currentSecond - SECS.raceStart) * 1000; // ms since 30s
                    const idx = Math.max(0, Math.min(Math.floor(elapsed / TICK_MS), rec.ticks.length - 1));
                    const positions = rec.ticks[idx]?.positions ?? [];
                    this.events.emit('tick', {
                        phase: this.state,
                        second: this.currentSecond,
                        data: { tickIndex: idx, positions },
                    });
                }
                else {
                    this.events.emit('tick', {
                        phase: this.state,
                        second: this.currentSecond,
                        data: { tickIndex: -1, positions: [] },
                    });
                }
            }
            else {
                this.events.emit('tick', {
                    phase: this.state,
                    second: this.currentSecond,
                    data: { tickIndex: -1, positions: [] },
                });
            }
            // Transition to race_finished at 51s
            if (this.currentSecond === SECS.finishedStart) {
                this.transition('race_finished');
            }
        }
        else if (this.inRange(SECS.finishedStart, SECS.finishedEnd)) {
            if (this.state === 'race_finished') {
                // Immediately enter results_showing (guarded transition)
                this.transition('results_showing');
            }
            else if (this.state !== 'results_showing') {
                this.state = 'results_showing';
                this.events.emit('state', {
                    phase: this.state,
                    second: this.currentSecond,
                });
            }
            // Optional per-second results updates
            this.events.emit('tick', {
                phase: this.state,
                second: this.currentSecond,
                data: { resultsVisible: true },
            });
            // Reset back to idle after 59s → next cycle
            if (this.currentSecond === SECS.finishedEnd) {
                this.transition('idle');
                // Clear seed on reset for next cycle
                RaceState.clearCurrentSeed();
                // currentSecond will snap to 0 on the next UTC :00 tick automatically
            }
        }
    }
    // Helper: Remaining seconds in the current mapped state window
    getRemainingSecondsInState() {
        if (this.state === 'idle')
            return SECS.idleEnd - this.currentSecond;
        if (this.state === 'countdown')
            return SECS.countdownEnd - this.currentSecond;
        if (this.state === 'race_starting')
            return SECS.raceStart - this.currentSecond;
        if (this.state === 'race_running')
            return SECS.finishedStart - this.currentSecond;
        if (this.state === 'race_finished')
            return SECS.finishedEnd - this.currentSecond;
        if (this.state === 'results_showing')
            return SECS.finishedEnd - this.currentSecond;
        return 0;
    }
    // Helper: Query current phase and second (for tests/UI)
    getPhaseAndSecond() {
        return { phase: this.state, second: this.currentSecond };
    }
    inRange(start, end) {
        return this.currentSecond >= start && this.currentSecond <= end;
    }
}
