import type { QueryResultRow } from 'pg'
import { getOptionalPool } from './pool.js'
import type {
  MarkRaceFinishedInput,
  RaceLifecycleStatus,
  RacePersistenceStatus,
  RecoverableRaceRecord,
  RaceRecord,
  UpsertSeededRaceInput,
} from './types.js'
import { isRaceDataPersistenceEnabled } from '../persistence/raceDataPersistencePolicy.js'
import { createRaceRef } from '../race/raceId.js'
import { rebindRaceLifecycleEventRaceRef } from '../financial/raceLifecycleContract.js'
import { persistLifecycleOutboxEvents } from '../financial/raceLifecycleOutbox.js'
import type { NinesRaceLifecycleEventV1 } from '../financial/raceLifecycleContract.js'
import { createRaceResultEvent } from '../financial/raceResultContract.js'
import {
  ImmutableResultEvidenceConflictError,
  persistResultOutboxEvent,
} from '../financial/raceResultOutbox.js'

type RaceRow = QueryResultRow & {
  race_id: string
  race_ref: string | null
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
  recovery_start_time?: Date | null
  betting_opens_at?: string | null
  betting_closes_at?: string | null
  has_lifecycle_open?: boolean
  has_lifecycle_close?: boolean
}

export class InvalidRaceLifecycleTransitionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidRaceLifecycleTransitionError'
  }
}

function normalizedJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizedJson)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, normalizedJson(entry)]),
    )
  }
  return value
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(normalizedJson(left)) === JSON.stringify(normalizedJson(right))
}

function assertCompatibleCompletion(
  row: RaceRow,
  input: MarkRaceFinishedInput,
): void {
  const conflicts =
    (row.actual_end_time !== null && input.actualEndTime !== null &&
      row.actual_end_time.getTime() !== input.actualEndTime.getTime()) ||
    (row.checksum !== null && input.checksum != null &&
      row.checksum !== input.checksum) ||
    (row.winner_id !== null && input.winnerId !== null &&
      row.winner_id !== input.winnerId) ||
    (row.finish_order.length > 0 && input.finishOrder.length > 0 &&
      !sameJson(row.finish_order, input.finishOrder)) ||
    (Object.keys(row.finish_times_ms).length > 0 &&
      Object.keys(input.finishTimesMs).length > 0 &&
      !sameJson(row.finish_times_ms, input.finishTimesMs))

  if (conflicts) {
    throw new ImmutableResultEvidenceConflictError(
      'Race already has different immutable result evidence',
    )
  }
}

function mapRaceRow(row: RaceRow): RaceRecord {
  return {
    raceId: row.race_id,
    raceRef: row.race_ref ?? null,
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

function mapRecoverableRaceRow(row: RaceRow): RecoverableRaceRecord {
  return {
    ...mapRaceRow(row),
    recoveryStartTime: row.recovery_start_time ?? null,
    bettingOpensAt: row.betting_opens_at ?? null,
    bettingClosesAt: row.betting_closes_at ?? null,
    hasLifecycleOpen: Boolean(row.has_lifecycle_open),
    hasLifecycleClose: Boolean(row.has_lifecycle_close),
  }
}

export interface RaceRepository {
  upsertSeededRace(input: UpsertSeededRaceInput): Promise<string | null>
  markRaceStarted(raceId: string, actualStartTime: Date): Promise<void>
  markRaceFinished(input: MarkRaceFinishedInput): Promise<void>
  markRaceArchived(raceId: string): Promise<void>
  markPersistenceStatus(
    raceId: string,
    status: RacePersistenceStatus,
  ): Promise<void>
  listUnresolvedRaces(): Promise<RecoverableRaceRecord[]>
  findCurrentRace(): Promise<RaceRecord | null>
  findPreviousRace(): Promise<RaceRecord | null>
  listRaceHistory(limit: number): Promise<RaceRecord[]>
  findRaceById(raceId: string): Promise<RaceRecord | null>
  findRaceByRef(raceRef: string): Promise<RaceRecord | null>
}

export class PgRaceRepository implements RaceRepository {
  async upsertSeededRace(input: UpsertSeededRaceInput): Promise<string | null> {
    if (!isRaceDataPersistenceEnabled()) return input.raceRef
    const pool = getOptionalPool()
    if (!pool) return input.raceRef

    let raceRef = input.raceRef
    for (let attempt = 0; attempt < 128; attempt++) {
      const client = await pool.connect()
      try {
        await client.query('begin')
        const result = await client.query<{ race_ref: string | null }>(
          `
        insert into races (
          race_id,
          race_ref,
          seed,
          lifecycle_status,
          scheduled_start_time,
          checksum,
          config,
          events_count,
          persistence_status,
          created_at,
          updated_at
        ) values ($1, $2, $3, 'seeded', $4, $5, $6::jsonb, $7, 'pending', now(), now())
        on conflict (race_id) do update
        set seed = excluded.seed,
            race_ref = coalesce(races.race_ref, excluded.race_ref),
            scheduled_start_time = excluded.scheduled_start_time,
            checksum = excluded.checksum,
            config = excluded.config,
            events_count = excluded.events_count,
            updated_at = now()
        where races.lifecycle_status = 'seeded'
          and races.seed = excluded.seed
          and races.scheduled_start_time is not distinct from excluded.scheduled_start_time
          and races.checksum is not distinct from excluded.checksum
          and races.config = excluded.config
          and races.events_count = excluded.events_count
        returning race_ref
          `,
          [
            input.raceId,
            raceRef,
            input.seed,
            input.scheduledStartTime ?? null,
            input.checksum ?? null,
            JSON.stringify(input.config),
            input.eventsCount ?? 0,
          ],
        )
        if (result.rowCount !== 1) {
          throw new InvalidRaceLifecycleTransitionError(
            `Race ${input.raceId} cannot be reseeded from its durable lifecycle state`,
          )
        }
        const storedRaceRef = result.rows[0]?.race_ref ?? raceRef
        if (input.lifecycleEvents?.length) {
          if (!storedRaceRef) throw new Error('A public race reference is required for lifecycle delivery')
          await persistLifecycleOutboxEvents(client, input.lifecycleEvents.map((event) =>
            event.raceRef === storedRaceRef ? event :
              rebindRaceLifecycleEventRaceRef(event, storedRaceRef)))
        }
        await client.query('commit')
        return storedRaceRef
      } catch (error: any) {
        await client.query('rollback').catch(() => {})
        const isRaceRefCollision =
          error?.code === '23505' &&
          (error?.constraint === 'races_race_ref_uidx' ||
            String(error?.message ?? '').includes('race_ref'))
        if (!isRaceRefCollision || raceRef === null) throw error
        raceRef = createRaceRef()
      } finally {
        client.release()
      }
    }
    throw new Error('Unable to persist a unique race reference')
  }

  async markRaceStarted(raceId: string, actualStartTime: Date): Promise<void> {
    if (!isRaceDataPersistenceEnabled()) return
    const pool = getOptionalPool()
    if (!pool) return

    const result = await pool.query(
      `
        update races
        set lifecycle_status = 'running',
            actual_start_time = coalesce(actual_start_time, $2),
            updated_at = now()
        where race_id = $1
          and lifecycle_status in ('seeded', 'running')
          and (actual_start_time is null or actual_start_time = $2)
        returning race_id
      `,
      [raceId, actualStartTime],
    )
    if (result.rowCount !== 1) {
      throw new InvalidRaceLifecycleTransitionError(
        `Race ${raceId} cannot transition to running`,
      )
    }
  }

  async markRaceFinished(input: MarkRaceFinishedInput): Promise<void> {
    if (!isRaceDataPersistenceEnabled()) return
    const pool = getOptionalPool()
    if (!pool) throw new Error('Durable race completion requires DATABASE_URL')

    const client = await pool.connect()
    try {
      await client.query('begin')
      const raceResult = await client.query<RaceRow>(`
        select * from races where race_id=$1 for update`, [input.raceId])
      const race = raceResult.rows[0]
      if (!race) throw new Error('Completed race was not found')
      assertCompatibleCompletion(race, input)
      const closeResult = await client.query<{ payload: NinesRaceLifecycleEventV1 }>(`
        select payload from race_lifecycle_outbox
        where race_id=$1 and lifecycle_sequence=2 limit 1 for update`, [input.raceId])
      const closeEvent = closeResult.rows[0]?.payload
      if (
        process.env.NINES_FINANCIAL_RACE_LIFECYCLE_ENABLED === 'true' &&
        !closeEvent
      ) {
        throw new Error(
          'Lifecycle-managed durable completion requires persisted race-close evidence',
        )
      }
      let resultEvent = null
      if (closeEvent) {
        if (!input.actualEndTime || !input.winnerId || !input.checksum) {
          throw new Error('A lifecycle-managed completed race requires time, winner, and checksum evidence')
        }
        resultEvent = createRaceResultEvent({ closeEvent,
          completedAt: input.actualEndTime.toISOString(), winnerId: input.winnerId,
          finishOrder: input.finishOrder, raceChecksum: input.checksum })
      }
      const update = await client.query(`
        update races
        set lifecycle_status = case
              when lifecycle_status = 'archived' then 'archived'
              when lifecycle_status = 'finished' then 'finished'
              when lifecycle_status = 'results_showing' and $2 = 'finished' then 'finished'
              else $2
            end,
            actual_end_time = coalesce(actual_end_time, $3),
            checksum = coalesce(checksum, $4),
            winner_id = coalesce(winner_id, $5),
            finish_order = case when finish_order = '[]'::jsonb then $6::jsonb else finish_order end,
            finish_times_ms = case when finish_times_ms = '{}'::jsonb then $7::jsonb else finish_times_ms end,
            has_tick_stream = has_tick_stream or $8,
            has_precomputed_paths = has_precomputed_paths or $9,
            events_count = greatest(events_count, $10::integer),
            persistence_status = case
              when persistence_status = 'saved' or $11 = 'saved' then 'saved'
              when persistence_status = 'partial' or $11 = 'partial' then 'partial'
              when persistence_status = 'unsaved' or $11 = 'unsaved' then 'unsaved'
              else 'pending'
            end,
            updated_at = now()
        where race_id = $1
        returning race_id
      `,
      [
        input.raceId,
        input.lifecycleStatus,
        input.actualEndTime,
        input.checksum ?? null,
        input.winnerId,
        JSON.stringify(input.finishOrder),
        JSON.stringify(input.finishTimesMs),
        input.hasTickStream,
        input.hasPrecomputedPaths,
        input.eventsCount,
        input.persistenceStatus,
      ],
      )
      if (update.rowCount !== 1) throw new Error('Completed race was not found')
      if (resultEvent) await persistResultOutboxEvent(client, resultEvent)
      await client.query('commit')
    } catch (error: any) {
      await client.query('rollback').catch(() => {})
      if (
        error?.code === '23505' &&
        String(error?.constraint ?? '').includes('race_result_outbox')
      ) {
        throw new ImmutableResultEvidenceConflictError(
          'Race already has different immutable result evidence',
          { cause: error },
        )
      }
      throw error
    } finally { client.release() }
  }

  async markRaceArchived(raceId: string): Promise<void> {
    if (!isRaceDataPersistenceEnabled()) return
    const pool = getOptionalPool()
    if (!pool) throw new Error('Durable race archival requires DATABASE_URL')

    const client = await pool.connect()
    try {
      await client.query('begin')
      const selected = await client.query<RaceRow>(`
        select * from races where race_id=$1 for update`, [raceId])
      const race = selected.rows[0]
      if (!race) {
        throw new InvalidRaceLifecycleTransitionError(
          `Race ${raceId} was not found for archival`,
        )
      }
      if (race.lifecycle_status === 'archived') {
        await client.query('commit')
        return
      }

      const outbox = await client.query<{ has_close: boolean; has_result: boolean }>(`
        select
          exists(select 1 from race_lifecycle_outbox
            where race_id=$1 and lifecycle_sequence=2) as has_close,
          exists(select 1 from race_result_outbox where race_id=$1) as has_result
      `, [raceId])
      const hasClose = Boolean(outbox.rows[0]?.has_close)
      const hasResult = Boolean(outbox.rows[0]?.has_result)
      const hasAuthoritativeResult =
        race.actual_end_time !== null &&
        race.checksum !== null &&
        race.winner_id !== null &&
        race.finish_order.length > 0 &&
        race.finish_order.includes(race.winner_id)
      if (
        !['finished', 'results_showing'].includes(race.lifecycle_status) ||
        !hasAuthoritativeResult ||
        (hasClose && !hasResult)
      ) {
        throw new InvalidRaceLifecycleTransitionError(
          `Race ${raceId} has not durably completed and cannot be archived`,
        )
      }

      const update = await client.query(`
        update races
        set lifecycle_status='archived',updated_at=now()
        where race_id=$1
          and lifecycle_status in ('finished','results_showing')
          and actual_end_time is not null
          and checksum is not null
          and winner_id is not null
          and jsonb_array_length(finish_order) > 0
        returning race_id`, [raceId])
      if (update.rowCount !== 1) {
        throw new InvalidRaceLifecycleTransitionError(
          `Race ${raceId} changed while archival was being committed`,
        )
      }
      await client.query('commit')
    } catch (error) {
      await client.query('rollback').catch(() => {})
      throw error
    } finally {
      client.release()
    }
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

  async listUnresolvedRaces(): Promise<RecoverableRaceRecord[]> {
    if (!isRaceDataPersistenceEnabled()) return []
    const pool = getOptionalPool()
    if (!pool) {
      throw new Error('Durable race recovery requires DATABASE_URL')
    }

    const result = await pool.query<RaceRow>(
      `
        select r.*,
               coalesce(
                 r.actual_start_time,
                 r.scheduled_start_time,
                 nullif(close_event.payload->>'bettingClosesAt', '')::timestamptz
               ) as recovery_start_time,
               open_event.payload->>'bettingOpensAt' as betting_opens_at,
               coalesce(
                 open_event.payload->>'bettingClosesAt',
                 close_event.payload->>'bettingClosesAt'
               ) as betting_closes_at,
               (open_event.lifecycle_event_id is not null) as has_lifecycle_open,
               (close_event.lifecycle_event_id is not null) as has_lifecycle_close
        from races r
        left join race_lifecycle_outbox open_event
          on open_event.race_id = r.race_id
         and open_event.lifecycle_sequence = 1
        left join race_lifecycle_outbox close_event
          on close_event.race_id = r.race_id
         and close_event.lifecycle_sequence = 2
        where r.lifecycle_status in ('seeded', 'running', 'finished', 'results_showing')
        order by coalesce(
          r.actual_start_time,
          r.scheduled_start_time,
          nullif(close_event.payload->>'bettingClosesAt', '')::timestamptz,
          r.created_at
        ) asc,
        r.race_id asc
      `,
    )
    return result.rows.map(mapRecoverableRaceRow)
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

  async findRaceByRef(raceRef: string): Promise<RaceRecord | null> {
    if (!isRaceDataPersistenceEnabled()) return null
    const pool = getOptionalPool()
    if (!pool) return null

    const result = await pool.query<RaceRow>(
      `
        select *
        from races
        where race_ref = $1
        limit 1
      `,
      [raceRef.toUpperCase()],
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
