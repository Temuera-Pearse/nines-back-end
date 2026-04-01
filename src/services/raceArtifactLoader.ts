import { promises as fs } from 'fs'
import type { RaceArtifactRecord } from '../db/types.js'

export interface RaceArtifactLoader {
  loadJson<T>(artifact: RaceArtifactRecord): Promise<T>
}

export class DefaultRaceArtifactLoader implements RaceArtifactLoader {
  async loadJson<T>(artifact: RaceArtifactRecord): Promise<T> {
    if (artifact.storageProvider === 'local_fs') {
      const raw = await fs.readFile(artifact.storageKey, 'utf8')
      return JSON.parse(raw) as T
    }

    if (artifact.storageProvider === 's3') {
      throw new Error('S3 artifact loading is not implemented yet')
    }

    throw new Error(`Unsupported storage provider: ${artifact.storageProvider}`)
  }
}

let sharedRaceArtifactLoader: RaceArtifactLoader | null = null

export function getRaceArtifactLoader(): RaceArtifactLoader {
  if (!sharedRaceArtifactLoader) {
    sharedRaceArtifactLoader = new DefaultRaceArtifactLoader()
  }
  return sharedRaceArtifactLoader
}
