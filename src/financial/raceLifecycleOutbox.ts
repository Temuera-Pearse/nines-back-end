import type { PoolClient, QueryResultRow } from 'pg'

import { getPool } from '../db/pool.js'
import type { NinesRaceLifecycleEventV1 } from './raceLifecycleContract.js'
import { NinesFinancialRaceLifecycleClientError,
  type NinesFinancialRaceLifecycleClient } from './NinesFinancialRaceLifecycleClient.js'

interface LifecycleOutboxRow extends QueryResultRow {
  lifecycle_event_id: string
  payload: NinesRaceLifecycleEventV1
  payload_hash: string
  attempt_count: number
}

export interface ClaimedRaceLifecycleEvent {
  event: NinesRaceLifecycleEventV1
  payloadHash: string
  attemptCount: number
}

export interface RaceLifecycleOutboxRepository {
  claim(now: Date): Promise<ClaimedRaceLifecycleEvent | null>
  delivered(eventId: string, payloadHash: string, now: Date): Promise<void>
  failed(eventId: string, payloadHash: string, now: Date, error: string, retryable: boolean,
    attemptCount: number): Promise<void>
}

export class PgRaceLifecycleOutboxRepository implements RaceLifecycleOutboxRepository {
  async claim(now: Date): Promise<ClaimedRaceLifecycleEvent | null> {
    const client = await getPool().connect()
    try {
      await client.query('begin')
      const result = await client.query<LifecycleOutboxRow>(`
        select lifecycle_event_id, payload, payload_hash, attempt_count
        from race_lifecycle_outbox
        where delivered_at is null and terminal_at is null and available_at <= $1
          and (locked_at is null or locked_at < $1::timestamptz - interval '30 seconds')
          and (lifecycle_sequence = 1 or exists (
            select 1 from race_lifecycle_outbox prerequisite
            where prerequisite.race_id = race_lifecycle_outbox.race_id
              and prerequisite.lifecycle_sequence = 1
              and prerequisite.delivered_at is not null
          ))
        order by available_at asc, created_at asc
        for update skip locked
        limit 1
      `, [now])
      const row = result.rows[0]
      if (!row) {
        await client.query('commit')
        return null
      }
      await client.query(`update race_lifecycle_outbox
        set locked_at=$2, attempt_count=attempt_count+1, updated_at=$2
        where lifecycle_event_id=$1`, [row.lifecycle_event_id, now])
      await client.query('commit')
      return { event: row.payload, payloadHash: row.payload_hash,
        attemptCount: Number(row.attempt_count) + 1 }
    } catch (error) {
      await client.query('rollback').catch(() => {})
      throw error
    } finally { client.release() }
  }

  async delivered(eventId: string, payloadHash: string, now: Date): Promise<void> {
    await getPool().query(`update race_lifecycle_outbox
      set delivered_at=$3, locked_at=null, last_error=null, updated_at=$3
      where lifecycle_event_id=$1 and payload_hash=$2 and terminal_at is null`,
    [eventId, payloadHash, now])
  }

  async failed(eventId: string, payloadHash: string, now: Date, error: string,
    retryable: boolean, attemptCount: number): Promise<void> {
    const delayMs = Math.min(60_000, 500 * (2 ** Math.min(attemptCount - 1, 7)))
    await getPool().query(`update race_lifecycle_outbox
      set locked_at=null, last_error=$4,
          terminal_at=case when $5::boolean then null::timestamptz else $3::timestamptz end,
          available_at=case when $5::boolean then $3::timestamptz + ($6::text || ' milliseconds')::interval
                            else available_at end,
          updated_at=$3
      where lifecycle_event_id=$1 and payload_hash=$2 and delivered_at is null`,
    [eventId, payloadHash, now, error.slice(0, 2_000), retryable, delayMs])
  }
}

export class RaceLifecycleDeliveryWorker {
  private timer: NodeJS.Timeout | null = null
  private running = false

  constructor(
    private readonly repository: RaceLifecycleOutboxRepository,
    private readonly client: Pick<NinesFinancialRaceLifecycleClient, 'deliver'>,
    private readonly pollIntervalMs: number,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async runOnce(): Promise<boolean> {
    const claimed = await this.repository.claim(this.clock())
    if (!claimed) return false
    try {
      await this.client.deliver(claimed.event)
      await this.repository.delivered(claimed.event.lifecycleEventId, claimed.payloadHash, this.clock())
    } catch (error) {
      const retryable = error instanceof NinesFinancialRaceLifecycleClientError
        ? error.retryable : true
      const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
      await this.repository.failed(claimed.event.lifecycleEventId, claimed.payloadHash,
        this.clock(), message, retryable, claimed.attemptCount)
    }
    return true
  }

  start(): void {
    if (this.running) return
    this.running = true
    const poll = async () => {
      if (!this.running) return
      try { while (this.running && await this.runOnce()) {} } catch (error) {
        console.warn(`Race lifecycle delivery poll failed: ${String(error)}`)
      }
      if (this.running) this.timer = setTimeout(poll, this.pollIntervalMs)
    }
    void poll()
  }

  stop(): void {
    this.running = false
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }
}

export async function persistLifecycleOutboxEvents(
  client: Pick<PoolClient, 'query'>,
  events: readonly NinesRaceLifecycleEventV1[],
): Promise<void> {
  for (const event of events) {
    const availableAt = event.eventType === 'nines_race_opened.v1'
      ? event.occurredAt : event.bettingClosesAt
    const result = await client.query(`insert into race_lifecycle_outbox
      (lifecycle_event_id,race_id,race_ref,event_type,lifecycle_sequence,payload,payload_hash,available_at)
      values ($1,$2,$3,$4,$5,$6::jsonb,$7,$8)
      on conflict (lifecycle_event_id) do update set updated_at=race_lifecycle_outbox.updated_at
      where race_lifecycle_outbox.payload_hash=excluded.payload_hash
      returning lifecycle_event_id`, [event.lifecycleEventId, event.raceId, event.raceRef,
      event.eventType, event.lifecycleSequence, JSON.stringify(event), event.evidenceHash, availableAt])
    if (result.rowCount !== 1) throw new Error('Lifecycle event identity was reused with conflicting evidence')
  }
}
