/**
 * Represents a horse in a race
 */
export interface Horse {
    id: string;
    name: string;
    position: number;
    minSpeed: number;
    maxSpeed: number;
}
/**
 * Represents a single tick update during a race
 */
export interface RaceTick {
    raceId: string;
    tick: number;
    horses: Array<{
        id: string;
        distance: number;
    }>;
}
/**
 * Final results of a completed race
 */
export interface RaceResult {
    raceId: string;
    finishOrder: string[];
    finishTimes: Record<string, number>;
}
/**
 * Complete race data
 */
export interface Race {
    id: string;
    horses: Horse[];
    isActive: boolean;
    winner?: Horse;
    placements: Horse[];
    lastBroadcastedTick: number;
}
export interface LiveRaceEvent {
    id: string;
    instanceId: string;
    tickIndex: number;
    affectedHorseIds: string[];
}
export interface LiveHorseEffect {
    horseId: string;
    activeEventIds: string[];
    isStunned: boolean;
    isRemoved: boolean;
}
export interface RaceFinishPresentation {
    bannerVisibleUntilUtc: string;
    resultsVisibleUntilUtc: string;
}
export interface RaceFinishPayload {
    raceId: string;
    timestampUtc: string;
    winnerId: string;
    finishOrder: string[];
    finishTimesMs: Record<string, number>;
    finishTickIndex: Record<string, number>;
    presentation: RaceFinishPresentation;
}
export interface RaceWinnerDeclaredPayload {
    raceId: string;
    timestampUtc: string;
    winnerId: string;
    finishOrder: string[];
    finishTimesMs: Record<string, number>;
    finishTickIndex: Record<string, number>;
    presentation: Pick<RaceFinishPresentation, 'bannerVisibleUntilUtc' | 'resultsVisibleUntilUtc'>;
}
export interface RaceFrameData {
    positions?: number[];
    deltas?: number[];
    events?: LiveRaceEvent[];
    effects?: LiveHorseEffect[];
}
/**
 * WebSocket message types
 */
export type WebSocketMessage = {
    type: 'race:info';
    protoVer: number;
    raceId: string;
    horseOrder: string[];
    config: RaceConfig;
    currentTickIndex: number;
} | {
    type: 'race:start';
    protoVer?: number;
    raceId: string;
    timestampUtc: string;
    horseOrder: string[];
    horses: Array<{
        id: string;
        name: string;
    }>;
} | {
    type: 'race:tick' | 'race:keyframe' | 'race:delta';
    protoVer?: number;
    raceId: string;
    seq?: number;
    tickIndex: number;
    tickTs?: number;
    data: RaceFrameData;
    sig?: string;
    keyId?: string;
} | {
    type: 'race:winner-declared';
    protoVer?: number;
    raceId: string;
    timestampUtc: string;
    winnerId: string;
    finishOrder: string[];
    finishTimesMs: Record<string, number>;
    finishTickIndex: Record<string, number>;
    presentation: Pick<RaceFinishPresentation, 'bannerVisibleUntilUtc' | 'resultsVisibleUntilUtc'>;
} | {
    type: 'race:finish';
    protoVer?: number;
    raceId: string;
    timestampUtc: string;
    winnerId: string;
    finishOrder: string[];
    finishTimesMs: Record<string, number>;
    finishTickIndex: Record<string, number>;
    presentation: RaceFinishPresentation;
} | {
    type: 'race:catchup';
    protoVer: number;
    raceId: string;
    startIndex: number;
    currentTickIndex: number;
    ticks: Array<{
        type: 'race:tick';
        protoVer: number;
        raceId: string;
        seq: number;
        tickIndex: number;
        tickTs: number;
        data: RaceFrameData;
    }>;
} | {
    type: 'race:sync-complete';
    protoVer: number;
    raceId: string;
    currentTickIndex: number;
} | {
    type: 'error';
    protoVer: number;
    message: string;
};
export interface RaceConfig {
    trackLength: number;
    finishRatio: number;
    durationMs: number;
    dtMs: number;
    seed: string;
}
export interface PositionUpdate {
    horseId: string;
    position: number;
}
export interface HorseSeed {
    id: string;
    name: string;
    baseSpeed: number;
    accelVariance: number;
    rngSeed: number;
}
export interface PrecomputedTick {
    timestampOffsetMs: number;
    positions: Array<{
        horseId: string;
        distance: number;
    }>;
}
export interface PrecomputedRace {
    id: string;
    config: RaceConfig;
    horses: HorseSeed[];
    ticks: PrecomputedTick[];
    finishLine: number;
    /** Optional lineage for deterministic replay */
    seedInt?: number;
    winnerId: string;
    finishOrder: string[];
    finishTimesMs: Record<string, number>;
    /** New: exact tick index at which each horse crosses the finish (floor of crossingMs/dtMs) */
    finishTickIndex: Record<string, number>;
    authoritativeFinish?: RaceFinishPayload;
    startTime?: Date;
    endTime?: Date;
    checksum?: string;
    /** Canonical event timeline used by all consumers */
    eventTimeline?: import('./events/timeline.js').EventTimeline;
    /** Canonical final horse state matrix (after applying all event effects) */
    finalHorseStateMatrix?: import('./events/effects.js').FinalHorseStateMatrix;
}
