export type RaceLifecycleStatus = 'seeded' | 'running' | 'finished' | 'results_showing' | 'archived';
export type RacePersistenceStatus = 'pending' | 'saved' | 'partial' | 'unsaved';
export type ArtifactType = 'summary' | 'event_timeline' | 'final_horse_state_matrix' | 'raw_ticks';
export type StorageProvider = 'local_fs' | 's3';
export interface RaceRecord {
    raceId: string;
    seed: string;
    lifecycleStatus: RaceLifecycleStatus;
    scheduledStartTime: Date | null;
    actualStartTime: Date | null;
    actualEndTime: Date | null;
    checksum: string | null;
    winnerId: string | null;
    finishOrder: string[];
    finishTimesMs: Record<string, number>;
    config: Record<string, unknown>;
    hasTickStream: boolean;
    hasPrecomputedPaths: boolean;
    eventsCount: number;
    persistenceStatus: RacePersistenceStatus;
    createdAt: Date;
    updatedAt: Date;
}
export interface UpsertSeededRaceInput {
    raceId: string;
    seed: string;
    scheduledStartTime?: Date | null;
    checksum?: string | null;
    config: Record<string, unknown>;
    eventsCount?: number;
}
export interface MarkRaceFinishedInput {
    raceId: string;
    actualEndTime: Date | null;
    checksum?: string | null;
    winnerId: string | null;
    finishOrder: string[];
    finishTimesMs: Record<string, number>;
    config: Record<string, unknown>;
    hasTickStream: boolean;
    hasPrecomputedPaths: boolean;
    eventsCount: number;
    persistenceStatus: RacePersistenceStatus;
    lifecycleStatus: Extract<RaceLifecycleStatus, 'finished' | 'results_showing'>;
}
export interface RaceArtifactRecord {
    id: number;
    raceId: string;
    artifactType: ArtifactType;
    storageProvider: StorageProvider;
    storageKey: string;
    contentType: string;
    byteSize: number | null;
    checksum: string | null;
    createdAt: Date;
}
export interface UpsertRaceArtifactInput {
    raceId: string;
    artifactType: ArtifactType;
    storageProvider: StorageProvider;
    storageKey: string;
    contentType: string;
    byteSize?: number | null;
    checksum?: string | null;
}
