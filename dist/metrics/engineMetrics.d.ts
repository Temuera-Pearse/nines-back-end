import { EventEmitter } from 'events';
type RollingStats = Readonly<{
    count: number;
    avg: number;
    max: number;
}>;
type MetricsSnapshot = Readonly<{
    startedAt: number | null;
    tickIntervalMs: number;
    ticksTotal: number;
    tickRate: number;
    tickWallAvgMs: number;
    tickCpuAvgMs: number;
    tickDrift: RollingStats;
    ws: Readonly<{
        clientCount: number;
        droppedTickFrames: number;
        avgBufferedAmount: number;
        latestSeqByRace: Readonly<Record<string, number>>;
    }>;
    gc: Readonly<{
        minorCount: number;
        majorCount: number;
        incrementalCount: number;
        weakCbCount: number;
        totalCount: number;
        totalDurationMs: number;
    }>;
    precompute: Readonly<{
        lastMs: number;
        avgMs: number;
        count: number;
        phases?: Readonly<Record<string, number>>;
    }>;
}>;
export declare class EngineMetrics {
    readonly events: EventEmitter<[never]>;
    private tickIntervalMs;
    private startedAt;
    private ticksTotal;
    private wallMs;
    private cpuMs;
    private driftMs;
    private tickTimes;
    private tickTimesMax;
    private gcMinor;
    private gcMajor;
    private gcIncremental;
    private gcWeakCb;
    private gcDurMs;
    private gcObs;
    private preLastMs;
    private preSumMs;
    private preCount;
    private prePhasesLast;
    private wallStart;
    private cpuStart;
    private wsClientCount;
    private wsDroppedTickFrames;
    private wsBufferedRing;
    private latestSeqByRace;
    constructor();
    startRace(tickIntervalMs: number): void;
    stopRace(): void;
    beforeTick(_tickIndex: number): void;
    afterTick(_tickIndex: number, driftMs: number | null): void;
    recordPrecomputeMs(ms: number): void;
    recordPrecomputePhase(phase: string, ms: number): void;
    getMetrics(): MetricsSnapshot;
    resetMetrics(): void;
    setClientCount(n: number): void;
    incDroppedTickFrames(n?: number): void;
    recordBufferedAmount(bytes: number): void;
    setLatestSeq(raceId: string, seq: number): void;
}
export declare const engineMetrics: EngineMetrics;
export {};
