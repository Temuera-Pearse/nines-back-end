import type { QueryResultRow } from 'pg'
import { getOptionalPool } from './pool.js'
import type {
  MarkRaceFinishedInput,
  RaceLifecycleStatus,
  RacePersistenceStatus,
  RaceRecord,
  UpsertSeededRaceInput,
} from './types.js'
import { isRaceDataPersistenceEnabled } from '../persistence/raceDataPersistencePolicy.js'

type RaceRow = QueryResultRow & {
  race_id: string
  seed: string
  lifecycle_status: RaceLifecycleStatus
  scheduled_start_time: Date | null
  actual_start_time: Date | null
  actual_end_time: Date | null
  checksum: string | null
  winner_id: string | null
  finish_order: string[]
  finish_times_ms: Record<string, number>
  config: Record<string, unknown>
  has_tick_stream: boolean
  has_precomputed_paths: boolean
  events_count: number
  persistence_status: RacePersistenceStatus
  created_at: Date
  updated_at: Date
}

function mapRaceRow(row: RaceRow): RaceRecord {
  return {
    raceId: row.race_id,
    seed: row.seed,
    lifecycleStatus: row.lifecycle_status,
    scheduledStartTime: row.scheduled_start_time,
    actualStartTime: row.actual_start_time,
    actualEndTime: row.actual_end_time,
    checksum: row.checksum,
    winnerId: row.winner_id,
    finishOrder: Array.isArray(row.finish_order) ? row.finish_order : [],
    finishTimesMs:
      row.finish_times_ms && typeof row.finish_times_ms === 'object'
        ? row.finish_times_ms
        : {},
    config: row.config && typeof row.config === 'object' ? row.config : {},
    hasTickStream: Boolean(row.has_tick_stream),
    hasPrecomputedPaths: Boolean(row.has_precomputed_paths),
    eventsCount: Number(row.events_count || 0),
    persistenceStatus: row.persistence_status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export interface RaceRepository {
  upsertSeededRace(input: UpsertSeededRaceInput): Promise<void>
  markRaceStarted(raceId: string, actualStartTime: Date): Promise<void>
  markRaceFinished(input: MarkRaceFinishedInput): Promise<void>
  markRaceArchived(raceId: string): Promise<void>
  markPersistenceStatus(
    raceId: string,
    status: RacePersistenceStatus,
  ): Promise<void>
  findCurrentRace(): Promise<RaceRecord | null>
  findPreviousRace(): Promise<RaceRecord | null>
  listRaceHistory(limit: number): Promise<RaceRecord[]>
  findRaceById(raceId: string): Promise<RaceRecord | null>
}

export class PgRaceRepository implements RaceRepository {
  async upsertSeededRace(input: UpsertSeededRaceInput): Promise<void> {
    if (!isRaceDataPersistenceEnabled()) return
    const pool = getOptionalPool()
    if (!pool) return

    await pool.query(
      `
        insert into races (
          race_id,
          seed,
          lifecycle_status,
          scheduled_start_time,
          checksum,
          config,
          events_count,
          persistence_status,
          created_at,
          updated_at
        ) values ($1, $2, 'seeded', $3, $4, $5::jsonb, $6, 'pending', now(), now())
        on conflict (race_id) do update
        set seed = excluded.seed,
            lifecycle_status = excluded.lifecycle_status,
            scheduled_start_time = excluded.scheduled_start_time,
            checksum = excluded.checksum,
            config = excluded.config,
            events_count = excluded.events_count,
            updated_at = now()
      `,
      [
        input.raceId,
        input.seed,
        input.scheduledStartTime ?? null,
        input.checksum ?? null,
        JSON.stringify(input.config),
        input.eventsCount ?? 0,
      ],
    )
  }

  async markRaceStarted(raceId: string, actualStartTime: Date): Promise<void> {
    if (!isRaceDataPersistenceEnabled()) return
    const pool = getOptionalPool()
    if (!pool) return

    await pool.query(
      `
        update races
        set lifecycle_status = 'running',
            actual_start_time = $2,
            updated_at = now()
        where race_id = $1
      `,
      [raceId, actualStartTime],
    )
  }

  async markRaceFinished(input: MarkRaceFinishedInput): Promise<void> {
    if (!isRaceDataPersistenceEnabled()) return
    const pool = getOptionalPool()
    if (!pool) return

    await pool.query(
      `
        update races
        set lifecycle_status = $2,
            actual_end_time = $3,
            checksum = $4,
            winner_id = $5,
            finish_order = $6::jsonb,
            finish_times_ms = $7::jsonb,
            config = $8::jsonb,
            has_tick_stream = $9,
            has_precomputed_paths = $10,
            events_count = $11,
            persistence_status = $12,
            updated_at = now()
        where race_id = $1
      `,
      [
        input.raceId,
        input.lifecycleStatus,
        input.actualEndTime,
        input.checksum ?? null,
        input.winnerId,
        JSON.stringify(input.finishOrder),
        JSON.stringify(input.finishTimesMs),
        JSON.stringify(input.config),
        input.hasTickStream,
        input.hasPrecomputedPaths,
        input.eventsCount,
        input.persistenceStatus,
      ],
    )
  }

  async markRaceArchived(raceId: string): Promise<void> {
    if (!isRaceDataPersistenceEnabled()) return
    const pool = getOptionalPool()
    if (!pool) return

    await pool.query(
      `
        update races
        set lifecycle_status = 'archived',
            updated_at = now()
        where race_id = $1
      `,
      [raceId],
    )
  }

  async markPersistenceStatus(
    raceId: string,
    status: RacePersistenceStatus,
  ): Promise<void> {
    if (!isRaceDataPersistenceEnabled()) return
    const pool = getOptionalPool()
    if (!pool) return

    await pool.query(
      `
        update races
        set persistence_status = $2,
            updated_at = now()
        where race_id = $1
      `,
      [raceId, status],
    )
  }

  async findCurrentRace(): Promise<RaceRecord | null> {
    if (!isRaceDataPersistenceEnabled()) return null
    const pool = getOptionalPool()
    if (!pool) return null

    const result = await pool.query<RaceRow>(
      `
        select *
        from races
        where lifecycle_status in ('seeded', 'running', 'results_showing')
        order by coalesce(actual_start_time, scheduled_start_time, created_at) desc
        limit 1
      `,
    )
    return result.rows[0] ? mapRaceRow(result.rows[0]) : null
  }

  async findPreviousRace(): Promise<RaceRecord | null> {
    if (!isRaceDataPersistenceEnabled()) return null
    const pool = getOptionalPool()
    if (!pool) return null

    const result = await pool.query<RaceRow>(
      `
        select *
        from races
        where lifecycle_status in ('finished', 'results_showing', 'archived')
        order by coalesce(actual_end_time, updated_at, created_at) desc
        limit 1
      `,
    )
    return result.rows[0] ? mapRaceRow(result.rows[0]) : null
  }

  async listRaceHistory(limit: number): Promise<RaceRecord[]> {
    if (!isRaceDataPersistenceEnabled()) return []
    const pool = getOptionalPool()
    if (!pool) return []

    const result = await pool.query<RaceRow>(
      `
        select *
        from races
        where lifecycle_status in ('finished', 'results_showing', 'archived')
        order by coalesce(actual_end_time, updated_at, created_at) desc
        limit $1
      `,
      [limit],
    )
    return result.rows.map(mapRaceRow)
  }

  async findRaceById(raceId: string): Promise<RaceRecord | null> {
    if (!isRaceDataPersistenceEnabled()) return null
    const pool = getOptionalPool()
    if (!pool) return null

    const result = await pool.query<RaceRow>(
      `
        select *
        from races
        where race_id = $1
        limit 1
      `,
      [raceId],
    )
    return result.rows[0] ? mapRaceRow(result.rows[0]) : null
  }
}

let sharedRaceRepository: RaceRepository | null = null

export function getRaceRepository(): RaceRepository {
  if (!sharedRaceRepository) {
    sharedRaceRepository = new PgRaceRepository()
  }
  return sharedRaceRepository
}
