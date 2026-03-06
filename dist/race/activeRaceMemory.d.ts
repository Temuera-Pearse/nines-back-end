export declare const TICK_MS = 50;
export interface RaceTick {
    tickIndex: number;
    positions: number[];
    /** Optional sequencing (monotonic per raceId) captured at broadcast time */
    seq?: number;
    /** Optional server-emission timestamp (ms since epoch) captured at broadcast time */
    tickTs?: number;
}
export declare const activeRaces: Map<string, {
    ticks: RaceTick[];
    startTime: number;
    currentTickIndex: number;
}>;
