import { RaceConfig, HorseSeed, PrecomputedRace, PrecomputedTick, PositionUpdate } from './raceTypes.js';
export declare const TRACK_LENGTH = 1000;
/**
 * Deterministically precompute all ticks using a single RNG instance.
 * Positions are integrated from smooth speed curves; no RNG at runtime.
 */
export declare function generateRaceTicks(horses: HorseSeed[], config: RaceConfig, rng: () => number): {
    ticks: PrecomputedTick[];
    finishOrder: string[];
    finishTimesMs: Record<string, number>;
    winnerId: string;
    finishTickIndex: Record<string, number>;
};
/**
 * Create and store a precomputed race shortly before the scheduled start.
 * Uses the single RNG created from the current seed stored in RaceState.
 */
export declare function seedPrecomputedRace(): PrecomputedRace;
/**
 * Bind the real-world clock to the precomputed race and mark it active.
 * - Sets the race startTime, initializes currentRace runtime state for broadcasting.
 * - Emits a 'race:start' WebSocket message with initial horse info.
 * - Returns the same PrecomputedRace with startTime stamped.
 */
export declare function startPrecomputedRace(startTime?: Date): PrecomputedRace;
/**
 * Stream the current tick to clients based on real-world elapsed time.
 * - Computes elapsed since startTime, finds closest precomputed tick by timestamp.
 * - Broadcasts 'race:tick' with per-horse positions.
 * - When duration ends, finalizes the race and emits 'race:finish'.
 * - Returns the PositionUpdate[] for the current tick.
 */
export declare function streamPrecomputedTicks(now?: Date): PositionUpdate[];
/**
 * Stream a specific precomputed tick by index (authoritative tick clock).
 * - Uses engine-provided tickIndex to select precomputed positions.
 * - Broadcasts sequentially; finishes when last tick reached.
 * - No Date.now usage; derives endTime from startTime + tick timestamp offset.
 */
export declare function streamPrecomputedTickAt(tickIndex: number): PositionUpdate[];
