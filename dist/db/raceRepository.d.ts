import type { MarkRaceFinishedInput, RacePersistenceStatus, RaceRecord, UpsertSeededRaceInput } from './types.js';
export interface RaceRepository {
    upsertSeededRace(input: UpsertSeededRaceInput): Promise<void>;
    markRaceStarted(raceId: string, actualStartTime: Date): Promise<void>;
    markRaceFinished(input: MarkRaceFinishedInput): Promise<void>;
    markRaceArchived(raceId: string): Promise<void>;
    markPersistenceStatus(raceId: string, status: RacePersistenceStatus): Promise<void>;
    findCurrentRace(): Promise<RaceRecord | null>;
    findPreviousRace(): Promise<RaceRecord | null>;
    listRaceHistory(limit: number): Promise<RaceRecord[]>;
    findRaceById(raceId: string): Promise<RaceRecord | null>;
}
export declare class PgRaceRepository implements RaceRepository {
    upsertSeededRace(input: UpsertSeededRaceInput): Promise<void>;
    markRaceStarted(raceId: string, actualStartTime: Date): Promise<void>;
    markRaceFinished(input: MarkRaceFinishedInput): Promise<void>;
    markRaceArchived(raceId: string): Promise<void>;
    markPersistenceStatus(raceId: string, status: RacePersistenceStatus): Promise<void>;
    findCurrentRace(): Promise<RaceRecord | null>;
    findPreviousRace(): Promise<RaceRecord | null>;
    listRaceHistory(limit: number): Promise<RaceRecord[]>;
    findRaceById(raceId: string): Promise<RaceRecord | null>;
}
export declare function getRaceRepository(): RaceRepository;
