import { createHash } from 'node:crypto'

import { canonicalizeJson, hashCanonicalJson, type WagerEnvironment } from './ninesPlaceBetContract.js'
import type { NinesRaceLifecycleEventV1 } from './raceLifecycleContract.js'

export const NINES_RACE_RESULT_PATH = '/internal/v1/race-results'
export const NINES_RACE_RESULT_SCHEMA_VERSION = 'nines-race-result.v1'
export const NINES_RACE_RESULT_EVENT_TYPE = 'nines_race_completed.v1'
export const NINES_RACE_RESULT_ACK_SCHEMA_VERSION = 'nines-race-result-ack.v1'

export interface NinesRaceResultV1 {
  schemaVersion: typeof NINES_RACE_RESULT_SCHEMA_VERSION
  eventType: typeof NINES_RACE_RESULT_EVENT_TYPE
  issuer: 'nines-back-end'
  audience: 'nines-financial'
  environment: WagerEnvironment
  raceId: string
  raceRef: string
  resultId: string
  resultVersion: 1
  completedAt: string
  winningRunnerId: string
  winningSelectionId: string
  finishOrder: readonly string[]
  raceChecksum: string
  closeLifecycleEventId: string
  closeLifecycleEvidenceHash: string
  correlationId: string
  causationId: string
  evidenceHash: string
}

export interface NinesRaceResultAckV1 {
  schemaVersion: typeof NINES_RACE_RESULT_ACK_SCHEMA_VERSION
  resultType: 'nines_race_result_ack'
  result: 'settled' | 'replayed'
  raceId: string
  raceRef: string
  resultId: string
  resultVersion: 1
  settlementRunId: string
  poolStatus: 'settled'
  totalPoolMinor: string
  acceptedStakeMinor: string
  appliedCarryoverMinor: string
  houseTakeMinor: string
  netPoolMinor: string
  roundingResidualMinor: string
  carryoverMinor: string
  settledAt: string
  correlationId: string
}

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }
const ID_PATTERN = /^[A-Za-z0-9:_-]{1,200}$/

function deterministicUuid(value: string): string {
  const hex = createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 32).split('')
  hex[12] = '5'
  hex[16] = 'a'
  return `${hex.slice(0, 8).join('')}-${hex.slice(8, 12).join('')}-${hex.slice(12, 16).join('')}-${hex.slice(16, 20).join('')}-${hex.slice(20).join('')}`
}

export function raceResultEvidenceHash(
  event: Omit<NinesRaceResultV1, 'evidenceHash'>,
): string {
  return hashCanonicalJson(event as unknown as JsonValue)
}

export function createRaceResultEvent(input: {
  closeEvent: NinesRaceLifecycleEventV1
  completedAt: string
  winnerId: string
  finishOrder: readonly string[]
  raceChecksum: string
}): Readonly<NinesRaceResultV1> {
  if (input.closeEvent.eventType !== 'nines_race_betting_closed.v1' ||
      input.closeEvent.lifecycleSequence !== 2) {
    throw new Error('Race result requires authoritative W2 close evidence')
  }
  const completedAtMs = Date.parse(input.completedAt)
  if (!Number.isFinite(completedAtMs) || completedAtMs < Date.parse(input.closeEvent.occurredAt)) {
    throw new Error('Race completion must occur at or after authoritative betting close')
  }
  if (!ID_PATTERN.test(input.winnerId) || input.finishOrder[0] !== input.winnerId) {
    throw new Error('Winning runner must be the first canonical finisher')
  }
  if (input.finishOrder.length !== input.closeEvent.selections.length ||
      new Set(input.finishOrder).size !== input.finishOrder.length) {
    throw new Error('Finish order must contain each authoritative runner exactly once')
  }
  const runnerSet = new Set(input.closeEvent.selections.map((selection) => selection.runnerId))
  if (input.finishOrder.some((runnerId) => !runnerSet.has(runnerId))) {
    throw new Error('Finish order contains a runner outside the W2 selection snapshot')
  }
  if (!/^[0-9a-f]{64}$/.test(input.raceChecksum)) {
    throw new Error('Race checksum must be a lowercase SHA-256 value')
  }
  const event = {
    schemaVersion: NINES_RACE_RESULT_SCHEMA_VERSION as typeof NINES_RACE_RESULT_SCHEMA_VERSION,
    eventType: NINES_RACE_RESULT_EVENT_TYPE as typeof NINES_RACE_RESULT_EVENT_TYPE,
    issuer: 'nines-back-end' as const,
    audience: 'nines-financial' as const,
    environment: input.closeEvent.environment,
    raceId: input.closeEvent.raceId,
    raceRef: input.closeEvent.raceRef,
    resultId: deterministicUuid(`${input.closeEvent.raceId}:${NINES_RACE_RESULT_EVENT_TYPE}:1`),
    resultVersion: 1 as const,
    completedAt: new Date(completedAtMs).toISOString(),
    winningRunnerId: input.winnerId,
    winningSelectionId: input.winnerId,
    finishOrder: Object.freeze([...input.finishOrder]),
    raceChecksum: input.raceChecksum,
    closeLifecycleEventId: input.closeEvent.lifecycleEventId,
    closeLifecycleEvidenceHash: input.closeEvent.evidenceHash,
    correlationId: input.closeEvent.correlationId,
    causationId: input.closeEvent.lifecycleEventId,
  }
  return Object.freeze({ ...event, evidenceHash: raceResultEvidenceHash(event) })
}

export function canonicalRaceResultJson(event: NinesRaceResultV1): string {
  return canonicalizeJson(event as unknown as JsonValue)
}
