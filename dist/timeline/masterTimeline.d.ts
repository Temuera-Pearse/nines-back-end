declare class MasterTimelineImpl {
    private timers;
    schedule(id: string, whenMsOrDate: number | Date, fn: () => void, raceId?: string): void;
    setInterval(id: string, intervalMs: number, fn: () => void, raceId?: string): void;
    clear(id: string): void;
    clearAllForRace(raceId: string): void;
    shutdown(): void;
    getTimerIds(): string[];
}
export declare const MasterTimeline: MasterTimelineImpl;
export {};
