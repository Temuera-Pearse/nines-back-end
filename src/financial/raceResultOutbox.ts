import type { PoolClient, QueryResultRow } from 'pg'

import { getPool } from '../db/pool.js'
import { NinesFinancialRaceResultClientError,
  type NinesFinancialRaceResultClient } from './NinesFinancialRaceResultClient.js'
import type { NinesRaceResultV1 } from './raceResultContract.js'

export class ImmutableResultEvidenceConflictError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'ImmutableResultEvidenceConflictError'
  }
}

interface ResultOutboxRow extends QueryResultRow {
  result_id: string
  payload: NinesRaceResultV1
  payload_hash: string
  attempt_count: number
}

export interface ClaimedRaceResult {
  event: NinesRaceResultV1
  payloadHash: string
  attemptCount: number
}

export interface RaceResultOutboxRepository {
  claim(now: Date): Promise<ClaimedRaceResult | null>
  delivered(resultId: string, payloadHash: string, now: Date): Promise<void>
  failed(resultId: string, payloadHash: string, now: Date, error: string, retryable: boolean,
    attemptCount: number): Promise<void>
}

export class PgRaceResultOutboxRepository implements RaceResultOutboxRepository {
  async claim(now: Date): Promise<ClaimedRaceResult | null> {
    const client = await getPool().connect()
    try {
      await client.query('begin')
      const result = await client.query<ResultOutboxRow>(`
        select result.result_id,result.payload,result.payload_hash,result.attempt_count
        from race_result_outbox result
        join race_lifecycle_outbox close_event
          on close_event.race_id = result.race_id
         and close_event.lifecycle_sequence = 2
         and close_event.delivered_at is not null
         and close_event.lifecycle_event_id::text = result.payload->>'closeLifecycleEventId'
         and close_event.payload_hash = result.payload->>'closeLifecycleEvidenceHash'
        where result.delivered_at is null and result.terminal_at is null
          and result.available_at <= $1
          and (result.locked_at is null or result.locked_at < $1::timestamptz - interval '30 seconds')
        order by result.available_at asc,result.created_at asc
        for update of result skip locked limit 1`, [now])
      const row = result.rows[0]
      if (!row) { await client.query('commit'); return null }
      await client.query(`update race_result_outbox set locked_at=$2,
        attempt_count=attempt_count+1,updated_at=$2 where result_id=$1`, [row.result_id, now])
      await client.query('commit')
      return { event: row.payload, payloadHash: row.payload_hash,
        attemptCount: Number(row.attempt_count) + 1 }
    } catch (error) {
      await client.query('rollback').catch(() => {})
      throw error
    } finally { client.release() }
  }

  async delivered(resultId: string, payloadHash: string, now: Date): Promise<void> {
    await getPool().query(`update race_result_outbox set delivered_at=$3,locked_at=null,
      last_error=null,updated_at=$3 where result_id=$1 and payload_hash=$2 and terminal_at is null`,
    [resultId, payloadHash, now])
  }

  async failed(resultId: string, payloadHash: string, now: Date, error: string,
    retryable: boolean, attemptCount: number): Promise<void> {
    const delayMs = Math.min(60_000, 500 * (2 ** Math.min(attemptCount - 1, 7)))
    await getPool().query(`update race_result_outbox set locked_at=null,last_error=$4,
      terminal_at=case when $5::boolean then null::timestamptz else $3::timestamptz end,
      available_at=case when $5::boolean then $3::timestamptz+($6::text||' milliseconds')::interval
                        else available_at end,updated_at=$3
      where result_id=$1 and payload_hash=$2 and delivered_at is null`,
    [resultId, payloadHash, now, error.slice(0, 2_000), retryable, delayMs])
  }
}

export class RaceResultDeliveryWorker {
  private timer: NodeJS.Timeout | null = null
  private running = false

  constructor(
    private readonly repository: RaceResultOutboxRepository,
    private readonly client: Pick<NinesFinancialRaceResultClient, 'deliver'>,
    private readonly pollIntervalMs: number,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async runOnce(): Promise<boolean> {
    const claimed = await this.repository.claim(this.clock())
    if (!claimed) return false
    try {
      await this.client.deliver(claimed.event)
      await this.repository.delivered(claimed.event.resultId, claimed.payloadHash, this.clock())
    } catch (error) {
      const retryable = error instanceof NinesFinancialRaceResultClientError ? error.retryable : true
      const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
      await this.repository.failed(claimed.event.resultId, claimed.payloadHash, this.clock(), message,
        retryable, claimed.attemptCount)
    }
    return true
  }

  start(): void {
    if (this.running) return
    this.running = true
    const poll = async () => {
      if (!this.running) return
      try { while (this.running && await this.runOnce()) {} } catch (error) {
        console.warn(`Race result delivery poll failed: ${String(error)}`)
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

export async function persistResultOutboxEvent(
  client: Pick<PoolClient, 'query'>,
  event: NinesRaceResultV1,
): Promise<void> {
  const result = await client.query(`insert into race_result_outbox
    (result_id,race_id,race_ref,result_version,payload,payload_hash,available_at)
    values ($1,$2,$3,$4,$5::jsonb,$6,$7)
    on conflict (result_id) do update set updated_at=race_result_outbox.updated_at
    where race_result_outbox.payload_hash=excluded.payload_hash returning result_id`,
  [event.resultId,event.raceId,event.raceRef,event.resultVersion,JSON.stringify(event),
    event.evidenceHash,event.completedAt])
  if (result.rowCount !== 1) {
    throw new ImmutableResultEvidenceConflictError(
      'Result identity was reused with conflicting evidence',
    )
  }
}
