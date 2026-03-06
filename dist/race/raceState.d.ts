import { PrecomputedRace, Race } from './raceTypes.js';
import { RaceStateMachine } from './stateMachine.js';
/**
 * Structured logging helpers
 */
type TickHorsePos = {
    horseId: string;
    distance: number;
};
type TickSummary = {
    index: number;
    timestampOffsetMs: number;
    elapsedMs: number;
    horses: TickHorsePos[];
};
type PrecomputeSummaryArgs = {
    raceId: string;
    tickCount: number;
    first3: TickSummary[];
    last3: TickSummary[];
    projectedWinnerId: string;
};
type RaceScheduleArgs = {
    raceId: string;
    trackLength: number;
    finishLine: number;
    durationMs: number;
    dtMs: number;
    seed?: string;
    winnerId?: string | null;
};
type CountdownArgs = {
    raceId: string;
    tMinusSec: number;
};
type RaceStartArgs = {
    raceId: string;
    timestamp: string;
};
type RaceFinishArgs = {
    raceId: string;
    timestamp: string;
    winnerId: string;
};
type RaceArchiveArgs = {
    raceId: string;
    durationMs: number;
};
type TickStreamArgs = {
    raceId: string;
    tick: TickSummary;
    broadcastCount: number;
};
type TickSkippedArgs = {
    raceId: string;
    skippedCount: number;
    reason?: string;
};
type DebugVelocityArgs = {
    raceId: string;
    tickIndex: number;
    velocities: {
        horseId: string;
        velocity: number;
    }[];
};
type DebugSeedArgs = {
    raceId: string;
    seed: string;
};
type DebugDriftArgs = {
    raceId: string;
    tickIndex: number;
    driftMs: number;
    correctionAppliedMs: number;
};
export declare const Log: {
    serverStart(): void;
    wsReady(clientCount?: number): void;
    raceScheduled(args: RaceScheduleArgs): void;
    countdown({ raceId, tMinusSec }: CountdownArgs): void;
    raceStart({ raceId, timestamp }: RaceStartArgs): void;
    raceFinish({ raceId, timestamp, winnerId }: RaceFinishArgs): void;
    raceArchive({ raceId, durationMs }: RaceArchiveArgs): void;
    precomputeSummary({ raceId, tickCount, first3, last3, projectedWinnerId, }: PrecomputeSummaryArgs): void;
    tickStream({ raceId, tick, broadcastCount }: TickStreamArgs): void;
    tickSkipped({ raceId, skippedCount, reason }: TickSkippedArgs): void;
    broadcastInfo(raceId: string, count: number): void;
    debugVelocity({ raceId, tickIndex, velocities }: DebugVelocityArgs): void;
    debugSeed({ raceId, seed }: DebugSeedArgs): void;
    debugDrift({ raceId, tickIndex, driftMs, correctionAppliedMs, }: DebugDriftArgs): void;
};
/**
 * Global race state stored in memory
 */
export declare class RaceState {
    private static currentRace;
    private static precomputed;
    private static previousRace;
    private static history;
    private static stateMachine;
    private static currentSeed;
    private static currentSeedInt;
    private static cycleCounter;
    /**
     * Get the currently running race
     */
    static getCurrentRace(): Race | null;
    /**
     * Set the current race
     */
    static setCurrentRace(race: Race | null): void;
    static getStateMachine(): RaceStateMachine;
    static setPrecomputedRace(r: PrecomputedRace | null): void;
    static getPrecomputedRace(): PrecomputedRace | null;
    static setCurrentSeed(seed: string | null): void;
    static getCurrentSeed(): string | null;
    static getCurrentSeedInt(): number | null;
    static clearCurrentSeed(): void;
    static bumpCycle(): number;
    static getCycleCounter(): number;
    /**
     * Complete a race and update state
     */
    static completeRace(): void;
    /**
     * Get race history (last 20 races)
     */
    static getHistory(): PrecomputedRace[];
    /**
     * Get the previously completed race
     */
    static getPreviousRace(): PrecomputedRace | null;
    /**
     * Find a race by ID
     */
    static findPrecomputedById(id: string): PrecomputedRace | null;
}
export {};
