type TimelineArtifact = Array<{
    tick: number;
    events: Array<{
        id: string;
        instanceId: string;
    }>;
}>;
export interface RaceReadService {
    getCurrentRaceSummary(): Promise<Record<string, unknown> | null>;
    getPreviousRaceSummary(): Promise<Record<string, unknown> | null>;
    getRaceHistory(limit: number): Promise<Record<string, unknown>[]>;
    getRaceResults(raceId: string): Promise<Record<string, unknown> | null>;
    getTimeline(raceId: string): Promise<TimelineArtifact | null>;
    getFinalTicks(raceId: string): Promise<Array<{
        tickIndex: number;
        positions: number[];
    }> | null>;
    getRawTicks(raceId: string): Promise<unknown[] | null>;
}
export declare class DefaultRaceReadService implements RaceReadService {
    private raceRepository;
    private raceArtifactRepository;
    private artifactLoader;
    getCurrentRaceSummary(): Promise<Record<string, unknown> | null>;
    getPreviousRaceSummary(): Promise<Record<string, unknown> | null>;
    getRaceHistory(limit: number): Promise<Record<string, unknown>[]>;
    getRaceResults(raceId: string): Promise<Record<string, unknown> | null>;
    getTimeline(raceId: string): Promise<TimelineArtifact | null>;
    getFinalTicks(raceId: string): Promise<Array<{
        tickIndex: number;
        positions: number[];
    }> | null>;
    getRawTicks(raceId: string): Promise<unknown[] | null>;
    private findArtifact;
}
export declare function getRaceReadService(): RaceReadService;
export {};
