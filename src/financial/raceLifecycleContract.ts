import { createHash } from 'node:crypto'

import { canonicalizeJson, hashCanonicalJson, type WagerEnvironment } from './ninesPlaceBetContract.js'

export const NINES_RACE_LIFECYCLE_PATH = '/internal/v1/race-lifecycle-events'
export const NINES_RACE_LIFECYCLE_SCHEMA_VERSION = 'nines-race-lifecycle-event.v1'
export const NINES_RACE_LIFECYCLE_ACK_SCHEMA_VERSION = 'nines-race-lifecycle-ack.v1'

export type RaceLifecycleEventType =
  | 'nines_race_opened.v1'
  | 'nines_race_betting_closed.v1'

export interface RaceLifecycleSelectionV1 {
  runnerId: string
  selectionId: string
  displayName: string
}

export interface RaceEconomicPolicyV1 {
  policyId: 'nines-parimutuel.v1'
  policyVersion: 1
  houseTakeBps: number
  carryoverPolicyId: 'nines-carryover.v1'
  carryoverPolicyVersion: 1
  settlementAllocationPolicyId: 'nines-proportional-allocation.v1'
  settlementAllocationPolicyVersion: 1
  roundingPolicyId: 'nines-largest-remainder.v1'
  roundingPolicyVersion: 1
}

export interface NinesRaceLifecycleEventV1 {
  schemaVersion: typeof NINES_RACE_LIFECYCLE_SCHEMA_VERSION
  eventType: RaceLifecycleEventType
  issuer: 'nines-back-end'
  audience: 'nines-financial'
  environment: WagerEnvironment
  raceId: string
  raceRef: string
  lifecycleEventId: string
  lifecycleSequence: 1 | 2
  bettingOpensAt: string
  bettingClosesAt: string
  selections: readonly RaceLifecycleSelectionV1[]
  currency: 'NINES'
  economicPolicy: RaceEconomicPolicyV1
  correlationId: string
  causationId: string
  occurredAt: string
  evidenceHash: string
}

export interface NinesRaceLifecycleAckV1 {
  schemaVersion: typeof NINES_RACE_LIFECYCLE_ACK_SCHEMA_VERSION
  resultType: 'nines_race_lifecycle_ack'
  result: 'projected' | 'replayed'
  raceId: string
  raceRef: string
  lifecycleEventId: string
  lifecycleSequence: number
  eventType: RaceLifecycleEventType
  poolStatus: 'open' | 'frozen'
  effectiveAt: string
  correlationId: string
}

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }
const RACE_ID_PATTERN = /^race-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const RACE_REF_PATTERN = /^N9-[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/
const ID_PATTERN = /^[A-Za-z0-9:_-]{1,200}$/

function deterministicUuid(value: string): string {
  const hex = createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 32).split('')
  hex[12] = '5'
  hex[16] = 'a'
  return `${hex.slice(0, 8).join('')}-${hex.slice(8, 12).join('')}-${hex.slice(12, 16).join('')}-${hex.slice(16, 20).join('')}-${hex.slice(20).join('')}`
}

function assertIso(value: string, name: string): void {
  if (!value || !Number.isFinite(Date.parse(value))) throw new Error(`${name} must be an ISO timestamp`)
}

export function raceLifecycleEvidenceHash(
  event: Omit<NinesRaceLifecycleEventV1, 'evidenceHash'>,
): string {
  return hashCanonicalJson(event as unknown as JsonValue)
}

export function createRaceLifecycleEvent(input: {
  eventType: RaceLifecycleEventType
  environment: WagerEnvironment
  raceId: string
  raceRef: string
  bettingOpensAt: string
  bettingClosesAt: string
  selections: readonly RaceLifecycleSelectionV1[]
  economicPolicy: RaceEconomicPolicyV1
  correlationId: string
  causationId: string
  occurredAt: string
}): Readonly<NinesRaceLifecycleEventV1> {
  if (!RACE_ID_PATTERN.test(input.raceId)) throw new Error('raceId must be the immutable backend race identity')
  if (!RACE_REF_PATTERN.test(input.raceRef)) throw new Error('raceRef must be a canonical public N9 reference')
  for (const [name, value] of [['correlationId', input.correlationId], ['causationId', input.causationId]] as const) {
    if (!ID_PATTERN.test(value)) throw new Error(`${name} is invalid`)
  }
  assertIso(input.bettingOpensAt, 'bettingOpensAt')
  assertIso(input.bettingClosesAt, 'bettingClosesAt')
  assertIso(input.occurredAt, 'occurredAt')
  if (Date.parse(input.bettingClosesAt) <= Date.parse(input.bettingOpensAt)) {
    throw new Error('bettingClosesAt must be after bettingOpensAt')
  }
  const sequence: 1 | 2 = input.eventType === 'nines_race_opened.v1' ? 1 : 2
  if (sequence === 1 && input.occurredAt !== input.bettingOpensAt) {
    throw new Error('Race-open event time must equal bettingOpensAt')
  }
  if (sequence === 2 && input.occurredAt !== input.bettingClosesAt) {
    throw new Error('Race-close event time must equal bettingClosesAt')
  }
  if (!Number.isInteger(input.economicPolicy.houseTakeBps) ||
      input.economicPolicy.houseTakeBps < 0 || input.economicPolicy.houseTakeBps > 10_000) {
    throw new Error('houseTakeBps must be an integer from 0 through 10000')
  }
  if (input.selections.length < 2 || input.selections.length > 64) {
    throw new Error('A lifecycle event must contain between 2 and 64 selections')
  }
  const selections = [...input.selections]
    .map((selection) => {
      if (!ID_PATTERN.test(selection.runnerId) || selection.runnerId !== selection.selectionId) {
        throw new Error('selectionId must equal its authoritative runnerId')
      }
      if (!selection.displayName.trim() || selection.displayName.length > 200) {
        throw new Error('Selection displayName is invalid')
      }
      return Object.freeze({ ...selection })
    })
    .sort((left, right) => left.selectionId.localeCompare(right.selectionId))
  if (new Set(selections.map((selection) => selection.selectionId)).size !== selections.length) {
    throw new Error('Lifecycle selections must be unique')
  }
  const lifecycleEventId = deterministicUuid(`${input.raceId}:${input.eventType}:${sequence}`)
  const event = {
    schemaVersion: NINES_RACE_LIFECYCLE_SCHEMA_VERSION as typeof NINES_RACE_LIFECYCLE_SCHEMA_VERSION,
    eventType: input.eventType,
    issuer: 'nines-back-end' as const,
    audience: 'nines-financial' as const,
    environment: input.environment,
    raceId: input.raceId,
    raceRef: input.raceRef,
    lifecycleEventId,
    lifecycleSequence: sequence,
    bettingOpensAt: input.bettingOpensAt,
    bettingClosesAt: input.bettingClosesAt,
    selections: Object.freeze(selections),
    currency: 'NINES' as const,
    economicPolicy: Object.freeze({ ...input.economicPolicy }),
    correlationId: input.correlationId,
    causationId: input.causationId,
    occurredAt: input.occurredAt,
  }
  return Object.freeze({ ...event, evidenceHash: raceLifecycleEvidenceHash(event) })
}

export function rebindRaceLifecycleEventRaceRef(
  event: NinesRaceLifecycleEventV1,
  raceRef: string,
): Readonly<NinesRaceLifecycleEventV1> {
  const { evidenceHash: _evidenceHash, ...payload } = event
  return createRaceLifecycleEvent({ ...payload, raceRef })
}

export function canonicalRaceLifecycleJson(event: NinesRaceLifecycleEventV1): string {
  return canonicalizeJson(event as unknown as JsonValue)
}
