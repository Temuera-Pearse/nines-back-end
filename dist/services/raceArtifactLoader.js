import { promises as fs } from 'fs';
export class DefaultRaceArtifactLoader {
    async loadJson(artifact) {
        if (artifact.storageProvider === 'local_fs') {
            const raw = await fs.readFile(artifact.storageKey, 'utf8');
            return JSON.parse(raw);
        }
        if (artifact.storageProvider === 's3') {
            throw new Error('S3 artifact loading is not implemented yet');
        }
        throw new Error(`Unsupported storage provider: ${artifact.storageProvider}`);
    }
}
let sharedRaceArtifactLoader = null;
export function getRaceArtifactLoader() {
    if (!sharedRaceArtifactLoader) {
        sharedRaceArtifactLoader = new DefaultRaceArtifactLoader();
    }
    return sharedRaceArtifactLoader;
}
