import { RaceStateMachine } from './stateMachine.js';
import { hashStringToInt } from './rng.js';
const ts = () => new Date().toISOString();
const fmt = (category, raceId) => `[${ts()}][${category}]${raceId ? `[${raceId}]` : ''}`;
const isDev = process.env.NODE_ENV === 'development' ||
    process.env.DEBUG === '1' ||
    process.env.LOG_DEV === '1';
export const Log = {
    serverStart() {
        console.log(`${fmt('SERVER')} Server starting`);
    },
    wsReady(clientCount) {
        console.log(`${fmt('WS')} WebSocket ready${clientCount !== undefined ? ` (clients=${clientCount})` : ''}`);
    },
    raceScheduled(args) {
        const { raceId, trackLength, finishLine, durationMs, dtMs, seed, winnerId, } = args;
        console.log(`${fmt('RACE', raceId)} Scheduled/seeded ` +
            JSON.stringify({
                trackLength,
                finishLine,
                durationMs,
                dtMs,
                seed,
                winnerId: winnerId ?? null,
            }));
    },
    countdown({ raceId, tMinusSec }) {
        console.log(`${fmt('COUNTDOWN', raceId)} T-${tMinusSec}s`);
    },
    raceStart({ raceId, timestamp }) {
        console.log(`${fmt('START', raceId)} at ${timestamp}`);
    },
    raceFinish({ raceId, timestamp, winnerId }) {
        console.log(`${fmt('FINISH', raceId)} at ${timestamp} winner=${winnerId}`);
    },
    raceArchive({ raceId, durationMs }) {
        console.log(`${fmt('ARCHIVE', raceId)} durationMs=${durationMs}`);
    },
    precomputeSummary({ raceId, tickCount, first3, last3, projectedWinnerId, }) {
        console.log(`${fmt('PRECOMPUTE', raceId)} tickCount=${tickCount} projectedWinner=${projectedWinnerId}`);
        const serializeTick = (t) => ({
            idx: t.index,
            offsetMs: t.timestampOffsetMs,
            horses: t.horses.map((h) => `${h.horseId}:${h.distance}`),
        });
        console.log(`${fmt('PRECOMPUTE', raceId)} first3=` +
            JSON.stringify(first3.map(serializeTick)));
        console.log(`${fmt('PRECOMPUTE', raceId)} last3=` +
            JSON.stringify(last3.map(serializeTick)));
    },
    tickStream({ raceId, tick, broadcastCount }) {
        console.log(`${fmt('TICK', raceId)} idx=${tick.index} elapsedMs=${tick.elapsedMs} offsetMs=${tick.timestampOffsetMs} ` +
            `horses=` +
            JSON.stringify(tick.horses) +
            ` broadcast=${broadcastCount}`);
    },
    tickSkipped({ raceId, skippedCount, reason }) {
        console.log(`${fmt('TICK-SKIP', raceId)} count=${skippedCount}` +
            (reason ? ` reason=${reason}` : ''));
    },
    broadcastInfo(raceId, count) {
        console.log(`${fmt('WS', raceId)} broadcast=${count}`);
    },
    // Debug-only logs
    debugVelocity({ raceId, tickIndex, velocities }) {
        if (!isDev)
            return;
        console.log(`${fmt('DEBUG-VEL', raceId)} idx=${tickIndex} ` +
            JSON.stringify(velocities.map((v) => ({ h: v.horseId, vel: v.velocity }))));
    },
    debugSeed({ raceId, seed }) {
        if (!isDev)
            return;
        console.log(`${fmt('DEBUG-SEED', raceId)} seed=${seed}`);
    },
    debugDrift({ raceId, tickIndex, driftMs, correctionAppliedMs, }) {
        if (!isDev)
            return;
        console.log(`${fmt('DEBUG-DRIFT', raceId)} idx=${tickIndex} driftMs=${driftMs} correctionMs=${correctionAppliedMs}`);
    },
};
/**
 * Global race state stored in memory
 */
export class RaceState {
    static currentRace = null;
    static precomputed = null;
    static previousRace = null;
    static history = [];
    static stateMachine = new RaceStateMachine();
    static currentSeed = null;
    static currentSeedInt = null;
    static cycleCounter = 0;
    /**
     * Get the currently running race
     */
    static getCurrentRace() {
        return this.currentRace;
    }
    /**
     * Set the current race
     */
    static setCurrentRace(race) {
        this.currentRace = race;
    }
    static getStateMachine() {
        return this.stateMachine;
    }
    static setPrecomputedRace(r) {
        this.precomputed = r;
    }
    static getPrecomputedRace() {
        return this.precomputed;
    }
    // Seed lifecycle (available during countdown, racing, results; cleared on reset)
    static setCurrentSeed(seed) {
        this.currentSeed = seed;
        if (seed) {
            // Compute 32-bit int for RNG determinism
            this.currentSeedInt = hashStringToInt(seed);
            Log.debugSeed({ raceId: this.precomputed?.id ?? 'pending', seed });
        }
        else {
            this.currentSeedInt = null;
        }
    }
    static getCurrentSeed() {
        return this.currentSeed;
    }
    static getCurrentSeedInt() {
        return this.currentSeedInt;
    }
    static clearCurrentSeed() {
        this.currentSeed = null;
        this.currentSeedInt = null;
    }
    // Cycle counter for deterministic per-cycle seed derivation
    static bumpCycle() {
        this.cycleCounter += 1;
        return this.cycleCounter;
    }
    static getCycleCounter() {
        return this.cycleCounter;
    }
    /**
     * Complete a race and update state
     */
    static completeRace() {
        if (this.precomputed) {
            Log.raceArchive({
                raceId: this.precomputed.id,
                durationMs: 
                // prefer explicit durationMs on precomputed, fall back to dt * ticks, or ticks length
                this.precomputed.durationMs ??
                    (this.precomputed.dtMs &&
                        (this.precomputed.ticks?.length ?? 0)
                        ? this.precomputed.dtMs * this.precomputed.ticks.length
                        : (this.precomputed.ticks?.length ?? 0)),
            });
            this.previousRace = this.precomputed;
            this.history.unshift(this.precomputed);
            if (this.history.length > 20)
                this.history = this.history.slice(0, 20);
            this.precomputed = null;
        }
        this.currentRace = null;
    }
    /**
     * Get race history (last 20 races)
     */
    static getHistory() {
        return [...this.history];
    }
    /**
     * Get the previously completed race
     */
    static getPreviousRace() {
        return this.previousRace;
    }
    /**
     * Find a race by ID
     */
    static findPrecomputedById(id) {
        if (this.precomputed?.id === id)
            return this.precomputed;
        if (this.previousRace?.id === id)
            return this.previousRace;
        return this.history.find((r) => r.id === id) || null;
    }
}
