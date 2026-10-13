import { createHash, randomUUID } from 'node:crypto'

import {
  NINES_RACE_RESULT_ACK_SCHEMA_VERSION,
  NINES_RACE_RESULT_PATH,
  canonicalRaceResultJson,
  type NinesRaceResultAckV1,
  type NinesRaceResultV1,
} from './raceResultContract.js'
import { signServiceMessage } from './serviceMessageAuthentication.js'

export class NinesFinancialRaceResultClientError extends Error {
  constructor(message: string, readonly retryable: boolean,
    readonly status: number | null, readonly code: string) {
    super(message)
    this.name = 'NinesFinancialRaceResultClientError'
  }
}

export interface NinesFinancialRaceResultClientOptions {
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

function parseAck(value: unknown): NinesRaceResultAckV1 {
  if (!value || typeof value !== 'object') throw new Error('Financial result response is not an object')
  const ack = value as Partial<NinesRaceResultAckV1>
  const moneyFields = ['totalPoolMinor', 'acceptedStakeMinor', 'appliedCarryoverMinor',
    'houseTakeMinor', 'netPoolMinor', 'roundingResidualMinor', 'carryoverMinor'] as const
  if (ack.schemaVersion !== NINES_RACE_RESULT_ACK_SCHEMA_VERSION ||
      ack.resultType !== 'nines_race_result_ack' ||
      !['settled', 'replayed'].includes(ack.result ?? '') ||
      typeof ack.raceId !== 'string' || typeof ack.raceRef !== 'string' ||
      typeof ack.resultId !== 'string' || ack.resultVersion !== 1 ||
      typeof ack.settlementRunId !== 'string' || ack.poolStatus !== 'settled' ||
      typeof ack.settledAt !== 'string' || typeof ack.correlationId !== 'string' ||
      moneyFields.some((field) => typeof ack[field] !== 'string')) {
    throw new Error('Financial response does not match nines-race-result-ack.v1')
  }
  return ack as NinesRaceResultAckV1
}

export class NinesFinancialRaceResultClient {
  private readonly baseUrl: URL
  private readonly timeoutMs: number
  private readonly maxAttempts: number
  private readonly fetchImplementation: typeof fetch
  private readonly clock: () => Date
  private readonly requestIdFactory: () => string

  constructor(private readonly options: NinesFinancialRaceResultClientOptions) {
    this.baseUrl = new URL(options.baseUrl)
    if (options.environment === 'production' && this.baseUrl.protocol !== 'https:') {
      throw new Error('Financial base URL must use HTTPS in production')
    }
    if (!options.keyId.trim() || options.secret.length < 32) {
      throw new Error('Financial result HMAC credentials are invalid')
    }
    this.timeoutMs = options.timeoutMs ?? 3_000
    this.maxAttempts = options.maxAttempts ?? 2
    if (this.timeoutMs <= 0 || this.maxAttempts <= 0) throw new Error('Timeout and max attempts must be positive')
    this.fetchImplementation = options.fetchImplementation ?? fetch
    this.clock = options.clock ?? (() => new Date())
    this.requestIdFactory = options.requestIdFactory ?? randomUUID
  }

  async deliver(event: Readonly<NinesRaceResultV1>): Promise<NinesRaceResultAckV1> {
    const body = canonicalRaceResultJson(event)
    const contentHash = createHash('sha256').update(body, 'utf8').digest('hex')
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      const requestId = this.requestIdFactory()
      const sentAt = this.clock().toISOString()
      const signature = signServiceMessage({ method: 'POST', path: NINES_RACE_RESULT_PATH,
        environment: this.options.environment, serviceId: 'nines-back-end',
        keyId: this.options.keyId, requestId, sentAt, contentHash, secret: this.options.secret })
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs)
      try {
        const response = await this.fetchImplementation(new URL(NINES_RACE_RESULT_PATH, this.baseUrl), {
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
          throw new NinesFinancialRaceResultClientError(
            'Financial rejected the authoritative race result', retryable, response.status, code)
        }
      } catch (error) {
        if (error instanceof NinesFinancialRaceResultClientError) throw error
        if (attempt === this.maxAttempts) {
          const timeoutFailure = error instanceof Error && error.name === 'AbortError'
          throw new NinesFinancialRaceResultClientError(
            timeoutFailure ? 'Financial result request timed out' : 'Financial result request failed',
            true, null, timeoutFailure ? 'FINANCIAL_TIMEOUT' : 'FINANCIAL_NETWORK_ERROR')
        }
      } finally { clearTimeout(timeout) }
    }
    throw new Error('Unreachable result retry state')
  }
}
