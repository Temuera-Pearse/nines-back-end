import type { RaceEconomicPolicyV1 } from './raceLifecycleContract.js'
import type { WagerEnvironment } from './ninesPlaceBetContract.js'

export interface RaceLifecycleDeliveryConfig {
  enabled: boolean
  environment: WagerEnvironment
  baseUrl?: string
  keyId?: string
  secret?: string
  pollIntervalMs: number
  timeoutMs: number
  maxAttempts: number
  policy?: RaceEconomicPolicyV1
}

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  const parsed = Number(value ?? String(fallback))
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`)
  return parsed
}

export function loadRaceLifecycleDeliveryConfig(
  environment: WagerEnvironment,
  source: NodeJS.ProcessEnv = process.env,
): RaceLifecycleDeliveryConfig {
  const enabled = source.NINES_FINANCIAL_RACE_LIFECYCLE_ENABLED === 'true'
  const pollIntervalMs = positiveInteger(source.NINES_FINANCIAL_RACE_LIFECYCLE_POLL_INTERVAL_MS,
    1_000, 'NINES_FINANCIAL_RACE_LIFECYCLE_POLL_INTERVAL_MS')
  const timeoutMs = positiveInteger(source.NINES_FINANCIAL_RACE_LIFECYCLE_TIMEOUT_MS,
    3_000, 'NINES_FINANCIAL_RACE_LIFECYCLE_TIMEOUT_MS')
  const maxAttempts = positiveInteger(source.NINES_FINANCIAL_RACE_LIFECYCLE_MAX_ATTEMPTS,
    2, 'NINES_FINANCIAL_RACE_LIFECYCLE_MAX_ATTEMPTS')
  if (!enabled) return { enabled, environment, pollIntervalMs, timeoutMs, maxAttempts }

  const baseUrl = source.NINES_FINANCIAL_BASE_URL?.trim()
  const keyId = source.NINES_FINANCIAL_AUTH_KEY_ID?.trim()
  const secret = source.NINES_FINANCIAL_AUTH_HMAC_SECRET?.trim()
  const houseTakeBps = Number(source.NINES_RACE_HOUSE_TAKE_BPS)
  if (!baseUrl || !keyId || !secret) {
    throw new Error('Financial base URL and HMAC credentials are required for race lifecycle delivery')
  }
  if (secret.length < 32) throw new Error('Financial HMAC secret must contain at least 32 characters')
  if (environment === 'production' && !baseUrl.startsWith('https://')) {
    throw new Error('Financial base URL must use HTTPS in production')
  }
  if (!Number.isInteger(houseTakeBps) || houseTakeBps < 0 || houseTakeBps > 10_000) {
    throw new Error('NINES_RACE_HOUSE_TAKE_BPS must explicitly configure an integer from 0 through 10000')
  }
  return {
    enabled, environment, baseUrl, keyId, secret, pollIntervalMs, timeoutMs, maxAttempts,
    policy: Object.freeze({
      policyId: 'nines-parimutuel.v1', policyVersion: 1, houseTakeBps,
      carryoverPolicyId: 'nines-carryover.v1', carryoverPolicyVersion: 1,
      settlementAllocationPolicyId: 'nines-proportional-allocation.v1',
      settlementAllocationPolicyVersion: 1,
      roundingPolicyId: 'nines-largest-remainder.v1', roundingPolicyVersion: 1,
    }),
  }
}

