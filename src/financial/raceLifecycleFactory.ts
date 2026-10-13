import type { PrecomputedRace } from '../race/raceTypes.js'
import { loadRaceLifecycleDeliveryConfig } from './raceLifecycleConfig.js'
import {
  createRaceLifecycleEvent,
  type NinesRaceLifecycleEventV1,
} from './raceLifecycleContract.js'
import type { WagerEnvironment } from './ninesPlaceBetContract.js'

function runtimeEnvironment(source: NodeJS.ProcessEnv): WagerEnvironment {
  const value = source.NODE_ENV ?? 'development'
  if (value !== 'development' && value !== 'test' && value !== 'production') {
    throw new Error('NODE_ENV must be development, test, or production')
  }
  return value
}

export function nextRaceStartAt(now: Date): Date {
  const closesAt = new Date(now)
  closesAt.setUTCMilliseconds(0)
  closesAt.setUTCSeconds(30)
  if (closesAt.getTime() <= now.getTime()) closesAt.setUTCMinutes(closesAt.getUTCMinutes() + 1)
  return closesAt
}

export function createLifecycleEventsForRace(
  race: Pick<PrecomputedRace, 'raceId' | 'raceRef' | 'horses'>,
  openedAt: Date,
  source: NodeJS.ProcessEnv = process.env,
): readonly NinesRaceLifecycleEventV1[] {
  const environment = runtimeEnvironment(source)
  const config = loadRaceLifecycleDeliveryConfig(environment, source)
  if (!config.enabled) return []
  if (!config.policy) throw new Error('Race lifecycle economic policy is required')
  const bettingOpensAt = openedAt.toISOString()
  const bettingClosesAt = nextRaceStartAt(openedAt).toISOString()
  const selections = race.horses.map((horse) => ({
    runnerId: horse.id,
    selectionId: horse.id,
    displayName: horse.name,
  }))
  const open = createRaceLifecycleEvent({
    eventType: 'nines_race_opened.v1', environment, raceId: race.raceId,
    raceRef: race.raceRef, bettingOpensAt, bettingClosesAt, selections,
    economicPolicy: config.policy, correlationId: race.raceId,
    causationId: `race-seeded:${race.raceId}`, occurredAt: bettingOpensAt,
  })
  const close = createRaceLifecycleEvent({
    eventType: 'nines_race_betting_closed.v1', environment, raceId: race.raceId,
    raceRef: race.raceRef, bettingOpensAt, bettingClosesAt, selections,
    economicPolicy: config.policy, correlationId: race.raceId,
    causationId: open.lifecycleEventId, occurredAt: bettingClosesAt,
  })
  return Object.freeze([open, close])
}

