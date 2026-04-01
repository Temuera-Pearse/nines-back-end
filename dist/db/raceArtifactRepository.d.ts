import type { ArtifactType, RaceArtifactRecord, UpsertRaceArtifactInput } from './types.js';
export interface RaceArtifactRepository {
    upsertArtifacts(artifacts: UpsertRaceArtifactInput[]): Promise<void>;
    findArtifact(raceId: string, artifactType: ArtifactType): Promise<RaceArtifactRecord | null>;
    findArtifactsByRaceId(raceId: string): Promise<RaceArtifactRecord[]>;
}
export declare class PgRaceArtifactRepository implements RaceArtifactRepository {
    upsertArtifacts(artifacts: UpsertRaceArtifactInput[]): Promise<void>;
    findArtifact(raceId: string, artifactType: ArtifactType): Promise<RaceArtifactRecord | null>;
    findArtifactsByRaceId(raceId: string): Promise<RaceArtifactRecord[]>;
}
export declare function getRaceArtifactRepository(): RaceArtifactRepository;
