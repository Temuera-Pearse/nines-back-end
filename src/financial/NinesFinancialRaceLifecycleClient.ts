import { createHash, randomUUID } from 'node:crypto'

import {
  NINES_RACE_LIFECYCLE_ACK_SCHEMA_VERSION,
  NINES_RACE_LIFECYCLE_PATH,
  canonicalRaceLifecycleJson,
  type NinesRaceLifecycleAckV1,
  type NinesRaceLifecycleEventV1,
} from './raceLifecycleContract.js'
import { signServiceMessage } from './serviceMessageAuthentication.js'

export class NinesFinancialRaceLifecycleClientError extends Error {
  constructor(message: string, readonly retryable: boolean,
    readonly status: number | null, readonly code: string) {
    super(message)
    this.name = 'NinesFinancialRaceLifecycleClientError'
  }
}

export interface NinesFinancialRaceLifecycleClientOptions {
  baseUrl: string
  environment: 'development' | 'test' | 'production'
  keyId: string
  secret: string
  timeoutMs?: number
  maxAttempts?: number
  fetchImplementation?: typeof fetch
  clock?: () => Date
  requestIdFactory?: () => string
}

function parseAck(value: unknown): NinesRaceLifecycleAckV1 {
  if (!value || typeof value !== 'object') throw new Error('Financial lifecycle response is not an object')
  const ack = value as Partial<NinesRaceLifecycleAckV1>
  if (ack.schemaVersion !== NINES_RACE_LIFECYCLE_ACK_SCHEMA_VERSION ||
      ack.resultType !== 'nines_race_lifecycle_ack' ||
      !['projected', 'replayed'].includes(ack.result ?? '') ||
      typeof ack.raceId !== 'string' || typeof ack.raceRef !== 'string' ||
      typeof ack.lifecycleEventId !== 'string' || typeof ack.lifecycleSequence !== 'number' ||
      !['nines_race_opened.v1', 'nines_race_betting_closed.v1'].includes(ack.eventType ?? '') ||
      !['open', 'frozen'].includes(ack.poolStatus ?? '') ||
      typeof ack.effectiveAt !== 'string' || typeof ack.correlationId !== 'string') {
    throw new Error('Financial response does not match nines-race-lifecycle-ack.v1')
  }
  return ack as NinesRaceLifecycleAckV1
}

export class NinesFinancialRaceLifecycleClient {
  private readonly baseUrl: URL
  private readonly timeoutMs: number
  private readonly maxAttempts: number
  private readonly fetchImplementation: typeof fetch
  private readonly clock: () => Date
  private readonly requestIdFactory: () => string

  constructor(private readonly options: NinesFinancialRaceLifecycleClientOptions) {
    this.baseUrl = new URL(options.baseUrl)
    if (options.environment === 'production' && this.baseUrl.protocol !== 'https:') {
      throw new Error('Financial base URL must use HTTPS in production')
    }
    if (!options.keyId.trim() || options.secret.length < 32) {
      throw new Error('Financial lifecycle HMAC credentials are invalid')
    }
    this.timeoutMs = options.timeoutMs ?? 3_000
    this.maxAttempts = options.maxAttempts ?? 2
    if (this.timeoutMs <= 0 || this.maxAttempts <= 0) throw new Error('Timeout and max attempts must be positive')
    this.fetchImplementation = options.fetchImplementation ?? fetch
    this.clock = options.clock ?? (() => new Date())
    this.requestIdFactory = options.requestIdFactory ?? randomUUID
  }

  async deliver(event: Readonly<NinesRaceLifecycleEventV1>): Promise<NinesRaceLifecycleAckV1> {
    const body = canonicalRaceLifecycleJson(event)
    const contentHash = createHash('sha256').update(body, 'utf8').digest('hex')
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      const requestId = this.requestIdFactory()
      const sentAt = this.clock().toISOString()
      const signature = signServiceMessage({ method: 'POST', path: NINES_RACE_LIFECYCLE_PATH,
        environment: this.options.environment, serviceId: 'nines-back-end',
        keyId: this.options.keyId, requestId, sentAt, contentHash, secret: this.options.secret })
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs)
      try {
        const response = await this.fetchImplementation(new URL(NINES_RACE_LIFECYCLE_PATH, this.baseUrl), {
          method: 'POST', signal: controller.signal, body,
          headers: { 'content-type': 'application/json', 'x-nines-service-id': 'nines-back-end',
            'x-nines-key-id': this.options.keyId, 'x-nines-request-id': requestId,
            'x-nines-sent-at': sentAt, 'x-nines-content-sha256': contentHash,
            'x-nines-signature': signature },
        })
        const responseBody = await response.json().catch(() => null) as unknown
        if (response.ok) return parseAck(responseBody)
        const retryable = response.status >= 500 ||
          Boolean((responseBody as { error?: { retryable?: boolean } } | null)?.error?.retryable)
        const code = (responseBody as { error?: { code?: string } } | null)?.error?.code ??
          `FINANCIAL_HTTP_${response.status}`
        if (!retryable || attempt === this.maxAttempts) {
          throw new NinesFinancialRaceLifecycleClientError(
            'Financial rejected the race lifecycle event', retryable, response.status, code)
        }
      } catch (error) {
        if (error instanceof NinesFinancialRaceLifecycleClientError) throw error
        if (attempt === this.maxAttempts) {
          const timeoutFailure = error instanceof Error && error.name === 'AbortError'
          throw new NinesFinancialRaceLifecycleClientError(
            timeoutFailure ? 'Financial lifecycle request timed out' : 'Financial lifecycle request failed',
            true, null, timeoutFailure ? 'FINANCIAL_TIMEOUT' : 'FINANCIAL_NETWORK_ERROR')
        }
      } finally {
        clearTimeout(timeout)
      }
    }
    throw new Error('Unreachable lifecycle retry state')
  }
}
