import { randomUUID } from 'node:crypto'

import {
  NINES_PLACE_BET_PATH,
  NINES_PLACE_BET_RESULT_SCHEMA_VERSION,
  canonicalizeJson,
  hashCanonicalJson,
  type NinesPlaceBetCommandV1,
  type NinesPlaceBetResultV1,
  type WagerEnvironment,
} from './ninesPlaceBetContract.js'
import { signServiceMessage } from './serviceMessageAuthentication.js'

export class NinesFinancialWagerClientError extends Error {
  constructor(message: string, readonly retryable: boolean,
    readonly status: number | null, readonly code: string) {
    super(message)
    this.name = 'NinesFinancialWagerClientError'
  }
}

export interface NinesFinancialWagerClientOptions {
  baseUrl: string
  environment: WagerEnvironment
  keyId: string
  secret: string
  timeoutMs?: number
  maxAttempts?: number
  fetchImplementation?: typeof fetch
  clock?: () => Date
  requestIdFactory?: () => string
}

function parseResult(value: unknown): NinesPlaceBetResultV1 {
  if (!value || typeof value !== 'object') throw new Error('Financial response is not an object')
  const result = value as Partial<NinesPlaceBetResultV1>
  if (result.schemaVersion !== NINES_PLACE_BET_RESULT_SCHEMA_VERSION ||
      result.resultType !== 'nines_place_bet_result' ||
      !['accepted', 'replayed', 'rejected'].includes(result.result ?? '') ||
      typeof result.betId !== 'string' || typeof result.playerId !== 'string' ||
      typeof result.raceId !== 'string' || typeof result.raceRef !== 'string' ||
      typeof result.selectionId !== 'string' || typeof result.correlationId !== 'string' ||
      typeof result.effectiveAt !== 'string' || !result.stake ||
      result.stake.currency !== 'NINES' || result.stake.scale !== 6 ||
      typeof result.stake.minorUnits !== 'string') {
    throw new Error('Financial response does not match nines-place-bet-result.v1')
  }
  return result as NinesPlaceBetResultV1
}

export class NinesFinancialWagerClient {
  private readonly baseUrl: URL
  private readonly timeoutMs: number
  private readonly maxAttempts: number
  private readonly fetchImplementation: typeof fetch
  private readonly clock: () => Date
  private readonly requestIdFactory: () => string

  constructor(private readonly options: NinesFinancialWagerClientOptions) {
    this.baseUrl = new URL(options.baseUrl)
    if (options.environment === 'production' && this.baseUrl.protocol !== 'https:') {
      throw new Error('Financial base URL must use HTTPS in production')
    }
    if (options.secret.length < 32) throw new Error('Financial HMAC secret must contain at least 32 characters')
    if (!options.keyId.trim()) throw new Error('Financial HMAC key ID is required')
    this.timeoutMs = options.timeoutMs ?? 3_000
    this.maxAttempts = options.maxAttempts ?? 2
    if (this.timeoutMs <= 0 || this.maxAttempts <= 0) throw new Error('Timeout and max attempts must be positive')
    this.fetchImplementation = options.fetchImplementation ?? fetch
    this.clock = options.clock ?? (() => new Date())
    this.requestIdFactory = options.requestIdFactory ?? randomUUID
  }

  async placeBet(command: Readonly<NinesPlaceBetCommandV1>): Promise<NinesPlaceBetResultV1> {
    const body = canonicalizeJson(command as unknown as Parameters<typeof canonicalizeJson>[0])
    const contentHash = hashCanonicalJson(command as unknown as Parameters<typeof hashCanonicalJson>[0])
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      const requestId = this.requestIdFactory()
      const sentAt = this.clock().toISOString()
      const signature = signServiceMessage({ method: 'POST', path: NINES_PLACE_BET_PATH,
        environment: this.options.environment, serviceId: 'nines-back-end',
        keyId: this.options.keyId, requestId, sentAt, contentHash, secret: this.options.secret })
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs)
      try {
        const response = await this.fetchImplementation(new URL(NINES_PLACE_BET_PATH, this.baseUrl), {
          method: 'POST', signal: controller.signal, body,
          headers: { 'content-type': 'application/json', 'x-nines-service-id': 'nines-back-end',
            'x-nines-key-id': this.options.keyId, 'x-nines-request-id': requestId,
            'x-nines-sent-at': sentAt, 'x-nines-content-sha256': contentHash,
            'x-nines-signature': signature },
        })
        const responseBody = await response.json().catch(() => null) as unknown
        if (response.ok) return parseResult(responseBody)
        const retryable = response.status >= 500 ||
          Boolean((responseBody as { error?: { retryable?: boolean } } | null)?.error?.retryable)
        const code = (responseBody as { error?: { code?: string } } | null)?.error?.code ??
          `FINANCIAL_HTTP_${response.status}`
        if (!retryable || attempt === this.maxAttempts) {
          throw new NinesFinancialWagerClientError('Financial rejected the wager request', retryable,
            response.status, code)
        }
      } catch (error) {
        if (error instanceof NinesFinancialWagerClientError) throw error
        if (attempt === this.maxAttempts) {
          const timeoutFailure = error instanceof Error && error.name === 'AbortError'
          throw new NinesFinancialWagerClientError(
            timeoutFailure ? 'Financial wager request timed out' : 'Financial wager request failed',
            true, null, timeoutFailure ? 'FINANCIAL_TIMEOUT' : 'FINANCIAL_NETWORK_ERROR')
        }
      } finally {
        clearTimeout(timeout)
      }
    }
    throw new Error('Unreachable wager retry state')
  }
}
