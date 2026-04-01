import { describe, expect, it } from 'vitest'

import { hashStringToInt } from '../../race/rng.js'
import { EVENT_CATALOG } from './catalog.js'
import { applyEventEffects, type HorsePathMatrix } from './effects.js'
import type { EventTimeline } from './timeline.js'

function createBaseHorsePaths(
  totalTicks: number,
  horseCount: number,
): HorsePathMatrix {
  return Object.freeze(
    Array.from({ length: totalTicks }, (_, tick) =>
      Object.freeze(
        Array.from({ length: horseCount }, (_, index) =>
          Object.freeze({
            horseId: `horse-${index + 1}`,
            position: tick * 5 + index,
            lane: index + 1,
            speed: 10,
          }),
        ),
      ),
    ),
  )
}

function createTimeline(eventId: string, instanceId: string): EventTimeline {
  return new Map([
    [
      0,
      Object.freeze([
        Object.freeze({
          id: eventId,
          tickIndex: 0,
          instanceId,
        }),
      ]),
    ],
  ])
}

function getAffectedHorseIds(
  matrix: ReturnType<typeof applyEventEffects>,
  tickIndex: number,
  eventId: string,
): string[] {
  return matrix[tickIndex]
    .filter((horse) => horse.activeEvents.includes(eventId))
    .map((horse) => horse.horseId)
}

function findInstanceIdForAnchor(
  eventId: string,
  horseCount: number,
  targetAnchorIndex: number,
): string {
  for (let attempt = 0; attempt < 10_000; attempt++) {
    const instanceId = `${eventId}-anchor-${targetAnchorIndex}-${attempt}`
    const anchorIndex =
      hashStringToInt(`${instanceId}${eventId}-aoe`) % horseCount
    if (anchorIndex === targetAnchorIndex) {
      return instanceId
    }
  }

  throw new Error(`Unable to find deterministic anchor for ${eventId}`)
}

describe('applyEventEffects', () => {
  it('limits chain_reaction to four horses deterministically', () => {
    const baseHorsePaths = createBaseHorsePaths(25, 6)
    const timeline = createTimeline('chain_reaction', 'chain-cap-test')

    const firstRun = applyEventEffects(baseHorsePaths, timeline, EVENT_CATALOG)
    const secondRun = applyEventEffects(baseHorsePaths, timeline, EVENT_CATALOG)

    expect(firstRun).toEqual(secondRun)

    const stunnedAtStart = firstRun[0].filter((horse) => horse.isStunned)
    const unaffectedAtStart = firstRun[0].filter((horse) => !horse.isStunned)

    expect(stunnedAtStart).toHaveLength(4)
    expect(unaffectedAtStart).toHaveLength(2)
    expect(
      stunnedAtStart.every(
        (horse) =>
          horse.activeEvents.includes('chain_reaction') &&
          horse.activeEvents.includes('chain_stun'),
      ),
    ).toBe(true)
    expect(
      unaffectedAtStart.every(
        (horse) =>
          !horse.activeEvents.includes('chain_reaction') &&
          !horse.activeEvents.includes('chain_stun'),
      ),
    ).toBe(true)

    expect(firstRun[19].filter((horse) => horse.isStunned)).toHaveLength(4)
    expect(firstRun[20].filter((horse) => horse.isStunned)).toHaveLength(0)
  })

  it('applies tornado to the anchor and immediate neighbors only', () => {
    const baseHorsePaths = createBaseHorsePaths(10, 10)
    const instanceId = findInstanceIdForAnchor('tornado', 10, 4)
    const result = applyEventEffects(
      baseHorsePaths,
      createTimeline('tornado', instanceId),
      EVENT_CATALOG,
    )

    expect(getAffectedHorseIds(result, 0, 'tornado')).toEqual([
      'horse-4',
      'horse-5',
      'horse-6',
    ])
  })

  it('clips tornado splash at the edge of the field', () => {
    const baseHorsePaths = createBaseHorsePaths(10, 10)
    const instanceId = findInstanceIdForAnchor('tornado', 10, 0)
    const result = applyEventEffects(
      baseHorsePaths,
      createTimeline('tornado', instanceId),
      EVENT_CATALOG,
    )

    expect(getAffectedHorseIds(result, 0, 'tornado')).toEqual([
      'horse-1',
      'horse-2',
    ])
  })

  it('applies earthquake to a five-horse contiguous area when centered', () => {
    const baseHorsePaths = createBaseHorsePaths(10, 10)
    const instanceId = findInstanceIdForAnchor('earthquake', 10, 5)
    const result = applyEventEffects(
      baseHorsePaths,
      createTimeline('earthquake', instanceId),
      EVENT_CATALOG,
    )

    expect(getAffectedHorseIds(result, 0, 'earthquake')).toEqual([
      'horse-4',
      'horse-5',
      'horse-6',
      'horse-7',
      'horse-8',
    ])
  })

  it('applies earthquake to three horses at the edge', () => {
    const baseHorsePaths = createBaseHorsePaths(10, 10)
    const instanceId = findInstanceIdForAnchor('earthquake', 10, 0)
    const result = applyEventEffects(
      baseHorsePaths,
      createTimeline('earthquake', instanceId),
      EVENT_CATALOG,
    )

    expect(getAffectedHorseIds(result, 0, 'earthquake')).toEqual([
      'horse-1',
      'horse-2',
      'horse-3',
    ])
  })

  it('limits bomb_throw to three horses', () => {
    const baseHorsePaths = createBaseHorsePaths(25, 10)
    const result = applyEventEffects(
      baseHorsePaths,
      createTimeline('bomb_throw', 'bomb-throw-cap-test'),
      EVENT_CATALOG,
    )

    const affected = result[0].filter((horse) =>
      horse.activeEvents.includes('bomb_throw'),
    )

    expect(affected).toHaveLength(3)
    expect(affected.every((horse) => horse.isStunned)).toBe(true)
  })

  it('limits smg_attack to one horse', () => {
    const baseHorsePaths = createBaseHorsePaths(10, 10)
    const result = applyEventEffects(
      baseHorsePaths,
      createTimeline('smg_attack', 'smg-attack-cap-test'),
      EVENT_CATALOG,
    )

    expect(getAffectedHorseIds(result, 0, 'smg_attack')).toHaveLength(1)
  })

  it('limits aerial_duel to two horses', () => {
    const baseHorsePaths = createBaseHorsePaths(10, 10)
    const result = applyEventEffects(
      baseHorsePaths,
      createTimeline('aerial_duel', 'aerial-duel-cap-test'),
      EVENT_CATALOG,
    )

    expect(getAffectedHorseIds(result, 0, 'aerial_duel')).toHaveLength(2)
  })

  it('limits magnet_pull to one horse', () => {
    const baseHorsePaths = createBaseHorsePaths(10, 10)
    const result = applyEventEffects(
      baseHorsePaths,
      createTimeline('magnet_pull', 'magnet-pull-cap-test'),
      EVENT_CATALOG,
    )

    expect(getAffectedHorseIds(result, 0, 'magnet_pull')).toHaveLength(1)
  })

  it('clamps instantaneous offsets at the finish line', () => {
    const baseHorsePaths: HorsePathMatrix = Object.freeze([
      Object.freeze([
        Object.freeze({
          horseId: 'horse-1',
          position: 95,
          lane: 1,
          speed: 10,
        }),
      ]),
      Object.freeze([
        Object.freeze({
          horseId: 'horse-1',
          position: 100,
          lane: 1,
          speed: 10,
        }),
      ]),
    ])

    const result = applyEventEffects(
      baseHorsePaths,
      createTimeline('rocket_boost', 'finish-line-clamp'),
      EVENT_CATALOG,
    )

    expect(result[1][0].position).toBe(100)
  })
})
