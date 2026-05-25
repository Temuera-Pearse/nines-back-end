import type { QueryResultRow } from 'pg'
import { getOptionalPool } from './pool.js'
import type {
  ArtifactType,
  RaceArtifactRecord,
  StorageProvider,
  UpsertRaceArtifactInput,
} from './types.js'
import { isRaceDataPersistenceEnabled } from '../persistence/raceDataPersistencePolicy.js'

type RaceArtifactRow = QueryResultRow & {
  id: number
  race_id: string
  artifact_type: ArtifactType
  storage_provider: StorageProvider
  storage_key: string
  content_type: string
  byte_size: string | number | null
  checksum: string | null
  created_at: Date
}

function mapArtifactRow(row: RaceArtifactRow): RaceArtifactRecord {
  return {
    id: row.id,
    raceId: row.race_id,
    artifactType: row.artifact_type,
    storageProvider: row.storage_provider,
    storageKey: row.storage_key,
    contentType: row.content_type,
    byteSize:
      row.byte_size === null
        ? null
        : Number.parseInt(String(row.byte_size), 10),
    checksum: row.checksum,
    createdAt: row.created_at,
  }
}

export interface RaceArtifactRepository {
  upsertArtifacts(artifacts: UpsertRaceArtifactInput[]): Promise<void>
  findArtifact(
    raceId: string,
    artifactType: ArtifactType,
  ): Promise<RaceArtifactRecord | null>
  findArtifactsByRaceId(raceId: string): Promise<RaceArtifactRecord[]>
}

export class PgRaceArtifactRepository implements RaceArtifactRepository {
  async upsertArtifacts(artifacts: UpsertRaceArtifactInput[]): Promise<void> {
    if (!isRaceDataPersistenceEnabled()) return
    const pool = getOptionalPool()
    if (!pool || artifacts.length === 0) return

    for (const artifact of artifacts) {
      await pool.query(
        `
          insert into race_artifacts (
            race_id,
            artifact_type,
            storage_provider,
            storage_key,
            content_type,
            byte_size,
            checksum,
            created_at
          ) values ($1, $2, $3, $4, $5, $6, $7, now())
          on conflict (race_id, artifact_type) do update
          set storage_provider = excluded.storage_provider,
              storage_key = excluded.storage_key,
              content_type = excluded.content_type,
              byte_size = excluded.byte_size,
              checksum = excluded.checksum
        `,
        [
          artifact.raceId,
          artifact.artifactType,
          artifact.storageProvider,
          artifact.storageKey,
          artifact.contentType,
          artifact.byteSize ?? null,
          artifact.checksum ?? null,
        ],
      )
    }
  }

  async findArtifact(
    raceId: string,
    artifactType: ArtifactType,
  ): Promise<RaceArtifactRecord | null> {
    if (!isRaceDataPersistenceEnabled()) return null
    const pool = getOptionalPool()
    if (!pool) return null

    const result = await pool.query<RaceArtifactRow>(
      `
        select *
        from race_artifacts
        where race_id = $1 and artifact_type = $2
        limit 1
      `,
      [raceId, artifactType],
    )
    return result.rows[0] ? mapArtifactRow(result.rows[0]) : null
  }

  async findArtifactsByRaceId(raceId: string): Promise<RaceArtifactRecord[]> {
    if (!isRaceDataPersistenceEnabled()) return []
    const pool = getOptionalPool()
    if (!pool) return []

    const result = await pool.query<RaceArtifactRow>(
      `
        select *
        from race_artifacts
        where race_id = $1
        order by created_at asc
      `,
      [raceId],
    )
    return result.rows.map(mapArtifactRow)
  }
}

let sharedRaceArtifactRepository: RaceArtifactRepository | null = null

export function getRaceArtifactRepository(): RaceArtifactRepository {
  if (!sharedRaceArtifactRepository) {
    sharedRaceArtifactRepository = new PgRaceArtifactRepository()
  }
  return sharedRaceArtifactRepository
}
