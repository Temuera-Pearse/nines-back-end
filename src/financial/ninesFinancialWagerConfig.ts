import type { NinesFinancialWagerClientOptions } from './NinesFinancialWagerClient.js'
import type { WagerEnvironment } from './ninesPlaceBetContract.js'

export function loadNinesFinancialWagerClientOptions(
  environment: WagerEnvironment,
  source: NodeJS.ProcessEnv = process.env,
): NinesFinancialWagerClientOptions {
  const baseUrl = source.NINES_FINANCIAL_BASE_URL?.trim()
  const keyId = source.NINES_FINANCIAL_AUTH_KEY_ID?.trim()
  const secret = source.NINES_FINANCIAL_AUTH_HMAC_SECRET?.trim()
  if (!baseUrl || !keyId || !secret) {
    throw new Error('NINES_FINANCIAL_BASE_URL, NINES_FINANCIAL_AUTH_KEY_ID, and NINES_FINANCIAL_AUTH_HMAC_SECRET are required')
  }
  const timeoutMs = Number(source.NINES_FINANCIAL_WAGER_TIMEOUT_MS ?? '3000')
  const maxAttempts = Number(source.NINES_FINANCIAL_WAGER_MAX_ATTEMPTS ?? '2')
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 ||
      !Number.isSafeInteger(maxAttempts) || maxAttempts <= 0) {
    throw new Error('Financial wager timeout and max attempts must be positive integers')
  }
  return { baseUrl, environment, keyId, secret, timeoutMs, maxAttempts }
}
