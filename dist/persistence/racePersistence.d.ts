import type { ArtifactType, StorageProvider } from '../db/types.js';
import type { PrecomputedRace, RaceFinishPayload } from '../race/raceTypes.js';
import type { FinalHorseStateMatrix } from '../race/events/effects.js';
import type { EventTimeline } from '../race/events/timeline.js';
import type { WinnerResult } from '../race/winner.js';
export type RaceOutcome = Readonly<{
    winnerId: string;
    finishOrder: ReadonlyArray<string>;
    finishTimesMs: Readonly<Record<string, number>>;
}>;
export type RaceData = Readonly<{
    raceId: string;
    seed: string;
    authoritativeFinish: RaceFinishPayload;
    precomputedPaths: FinalHorseStateMatrix | ReadonlyArray<unknown>;
    tickStream?: ReadonlyArray<unknown>;
    eventTimeline: EventTimeline;
    outcome: RaceOutcome;
    winner: WinnerResult;
    config?: PrecomputedRace['config'];
    checksum?: string;
}>;
export type PersistenceStatus = 'saved' | 'partial' | 'unsaved';
export type PersistedArtifactDescriptor = Readonly<{
    artifactType: ArtifactType;
    storageProvider: StorageProvider;
    storageKey: string;
    contentType: string;
    byteSize?: number;
    checksum?: string;
}>;
export type SaveRaceResult = Readonly<{
    persistenceStatus: PersistenceStatus;
    artifacts: ReadonlyArray<PersistedArtifactDescriptor>;
    hasPrecomputedPaths: boolean;
    hasTickStream: boolean;
    eventsCount: number;
}>;
export interface RacePersistence {
    saveRace(raceId: string, data: RaceData): Promise<SaveRaceResult>;
    markUnsaved(raceId: string): void;
}
/**
 * File-based persistence implementation (JSON).
 * - Async and non-blocking; errors are logged and do not throw to callers by default.
 * - Atomic summary write via a temp file + rename.
 * - Extensible to DB/cloud backends by swapping implementation.
 */
export declare class FileRacePersistence implements RacePersistence {
    private baseDir;
    private unsaved;
    constructor(baseDir?: string);
    saveRace(raceId: string, data: RaceData): Promise<SaveRaceResult>;
    markUnsaved(raceId: string): void;
}
/**
 * S3-based persistence implementation.
 * Controlled via environment:
 * - PERSIST_S3_BUCKET: bucket name
 * - PERSIST_S3_PREFIX: key prefix (optional)
 */
export declare class S3RacePersistence implements RacePersistence {
    private bucket;
    private prefix;
    private s3;
    constructor(bucket: string, prefix?: string);
    saveRace(raceId: string, data: RaceData): Promise<SaveRaceResult>;
    markUnsaved(_raceId: string): void;
    private keyFor;
    private putJson;
}
export declare function getRacePersistence(): RacePersistence;
