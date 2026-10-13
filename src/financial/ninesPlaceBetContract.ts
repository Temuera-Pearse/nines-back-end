import { createHash, randomUUID } from 'node:crypto'

export const NINES_PLACE_BET_PATH = '/internal/v1/wagers/place-bet'
export const NINES_PLACE_BET_SCHEMA_VERSION = 'nines-place-bet-command.v1'
export const NINES_PLAYER_ASSERTION_SCHEMA_VERSION =
  'nines-player-identity-assertion.v1'
export const NINES_PLACE_BET_RESULT_SCHEMA_VERSION = 'nines-place-bet-result.v1'

export type WagerEnvironment = 'development' | 'test' | 'production'

export interface TrustedPlayerIdentityV1 {
  schemaVersion: typeof NINES_PLAYER_ASSERTION_SCHEMA_VERSION
  assertionId: string
  subjectPlayerId: string
  assertedBy: 'nines-back-end'
  authenticationMethod: 'upstream_access_token'
  authenticatedAt: string
  expiresAt: string
}

export interface NinesPlaceBetCommandV1 {
  schemaVersion: typeof NINES_PLACE_BET_SCHEMA_VERSION
  commandType: 'nines_place_bet'
  issuer: 'nines-back-end'
  audience: 'nines-financial'
  environment: WagerEnvironment
  betId: string
  playerId: string
  /** Private backend race_id and Financial's economic primary race key. */
  raceId: string
  /** Public, display/correlation-only race reference. */
  raceRef: string
  selectionId: string
  stake: { currency: 'NINES'; scale: 6; minorUnits: string }
  idempotencyKey: string
  requestedAt: string
  correlationId: string
  causationId: string
  playerIdentity: TrustedPlayerIdentityV1
  evidenceHash: string
}

export interface NinesPlaceBetResultV1 {
  schemaVersion: typeof NINES_PLACE_BET_RESULT_SCHEMA_VERSION
  resultType: 'nines_place_bet_result'
  result: 'accepted' | 'replayed' | 'rejected'
  betId: string
  playerId: string
  raceId: string
  raceRef: string
  selectionId: string
  stake: { currency: 'NINES'; scale: 6; minorUnits: string }
  reservationTransactionId: string | null
  rejectionCode: string | null
  effectiveAt: string
  correlationId: string
}

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

export function canonicalizeJson(value: JsonValue): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalizeJson).join(',')}]`
  return `{${Object.keys(value).sort().map((key) => {
    const entry = value[key]
    if (entry === undefined) throw new TypeError(`Canonical JSON does not permit undefined at ${key}`)
    return `${JSON.stringify(key)}:${canonicalizeJson(entry)}`
  }).join(',')}}`
}

export function hashCanonicalJson(value: JsonValue): string {
  return createHash('sha256').update(canonicalizeJson(value), 'utf8').digest('hex')
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const IDENTITY_PATTERN = /^[A-Za-z0-9:_-]{1,128}$/
const MAX_PLAYER_ASSERTION_LIFETIME_MS = 5 * 60_000

function assertIso(value: string, name: string): void {
  if (!value || !Number.isFinite(Date.parse(value))) throw new Error(`${name} must be an ISO timestamp`)
}

export function createTrustedPlayerIdentity(input: {
  playerId: string
  authenticatedAt: string
  expiresAt: string
  assertionId?: string
}): Readonly<TrustedPlayerIdentityV1> {
  if (!UUID_PATTERN.test(input.playerId)) throw new Error('playerId must be a UUID')
  assertIso(input.authenticatedAt, 'authenticatedAt')
  assertIso(input.expiresAt, 'expiresAt')
  if (Date.parse(input.expiresAt) < Date.parse(input.authenticatedAt)) {
    throw new Error('Player assertion expiry must not precede authentication')
  }
  if (Date.parse(input.expiresAt) - Date.parse(input.authenticatedAt) >
      MAX_PLAYER_ASSERTION_LIFETIME_MS) {
    throw new Error('Player assertion lifetime must not exceed five minutes')
  }
  const assertionId = input.assertionId ?? randomUUID()
  if (!UUID_PATTERN.test(assertionId)) throw new Error('assertionId must be a UUID')
  return Object.freeze({
    schemaVersion: NINES_PLAYER_ASSERTION_SCHEMA_VERSION,
    assertionId,
    subjectPlayerId: input.playerId,
    assertedBy: 'nines-back-end',
    authenticationMethod: 'upstream_access_token',
    authenticatedAt: input.authenticatedAt,
    expiresAt: input.expiresAt,
  })
}

export function createNinesPlaceBetCommand(input: {
  environment: WagerEnvironment
  betId: string
  playerId: string
  raceId: string
  raceRef: string
  selectionId: string
  stakeMinor: string
  idempotencyKey: string
  requestedAt: string
  correlationId: string
  causationId: string
  playerIdentity: TrustedPlayerIdentityV1
}): Readonly<NinesPlaceBetCommandV1> {
  for (const [name, value] of [['betId', input.betId], ['playerId', input.playerId]] as const) {
    if (!UUID_PATTERN.test(value)) throw new Error(`${name} must be a UUID`)
  }
  for (const [name, value] of [['raceId', input.raceId], ['raceRef', input.raceRef],
    ['selectionId', input.selectionId], ['correlationId', input.correlationId],
    ['causationId', input.causationId]] as const) {
    if (!IDENTITY_PATTERN.test(value)) throw new Error(`${name} is invalid`)
  }
  if (!/^N9-[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/.test(input.raceRef)) {
    throw new Error('raceRef must be a canonical public N9 reference')
  }
  if (!input.idempotencyKey.trim() || input.idempotencyKey.length > 200) {
    throw new Error('idempotencyKey is invalid')
  }
  if (!/^[1-9][0-9]{0,19}$/.test(input.stakeMinor)) throw new Error('stakeMinor is invalid')
  assertIso(input.requestedAt, 'requestedAt')
  if (input.playerIdentity.subjectPlayerId !== input.playerId ||
      input.playerIdentity.assertedBy !== 'nines-back-end' ||
      input.playerIdentity.schemaVersion !== NINES_PLAYER_ASSERTION_SCHEMA_VERSION ||
      Date.parse(input.playerIdentity.authenticatedAt) > Date.parse(input.requestedAt) ||
      Date.parse(input.playerIdentity.expiresAt) < Date.parse(input.requestedAt)) {
    throw new Error('Trusted player assertion is not bound to this wager')
  }
  const payload = {
    schemaVersion: NINES_PLACE_BET_SCHEMA_VERSION as typeof NINES_PLACE_BET_SCHEMA_VERSION,
    commandType: 'nines_place_bet' as const,
    issuer: 'nines-back-end' as const,
    audience: 'nines-financial' as const,
    environment: input.environment,
    betId: input.betId,
    playerId: input.playerId,
    raceId: input.raceId,
    raceRef: input.raceRef,
    selectionId: input.selectionId,
    stake: Object.freeze({ currency: 'NINES' as const, scale: 6 as const, minorUnits: input.stakeMinor }),
    idempotencyKey: input.idempotencyKey,
    requestedAt: input.requestedAt,
    correlationId: input.correlationId,
    causationId: input.causationId,
    playerIdentity: Object.freeze({ ...input.playerIdentity }),
  }
  const evidenceHash = hashCanonicalJson(payload as unknown as JsonValue)
  return Object.freeze({ ...payload, evidenceHash })
}
