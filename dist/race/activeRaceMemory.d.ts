import type { LiveHorseEffect, LiveRaceEvent } from './raceTypes.js';
export declare const TICK_MS = 50;
export interface RaceTick {
    tickIndex: number;
    positions: number[];
    events?: LiveRaceEvent[];
    effects?: LiveHorseEffect[];
    /** Optional sequencing (monotonic per raceId) captured at broadcast time */
    seq?: number;
    /** Optional server-emission timestamp (ms since epoch) captured at broadcast time */
    tickTs?: number;
}
export declare const activeRaces: Map<string, {
    ticks: RaceTick[];
    startTime: number;
    currentTickIndex: number;
    winnerDeclaredSent: boolean;
}>;
