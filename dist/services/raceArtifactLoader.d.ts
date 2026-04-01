import type { RaceArtifactRecord } from '../db/types.js';
export interface RaceArtifactLoader {
    loadJson<T>(artifact: RaceArtifactRecord): Promise<T>;
}
export declare class DefaultRaceArtifactLoader implements RaceArtifactLoader {
    loadJson<T>(artifact: RaceArtifactRecord): Promise<T>;
}
export declare function getRaceArtifactLoader(): RaceArtifactLoader;
