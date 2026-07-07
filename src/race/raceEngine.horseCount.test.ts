import { afterEach, describe, expect, it } from 'vitest'

import { HORSE_COUNT, getHorseId } from './raceConstants.js'
import { seedPrecomputedRace } from './raceEngine.js'
import { RaceState } from './raceState.js'

describe('race participant count', () => {
  afterEach(() => {
    RaceState.setCurrentSeed('')
    RaceState.setPrecomputedRace(null)
  })

  it('seeds exactly the configured zero-based horse field', () => {
    RaceState.setCurrentSeed('horse-count-test')

    const race = seedPrecomputedRace()

    expect(race.horses).toHaveLength(HORSE_COUNT)
    expect(race.horses.map((horse) => horse.id)).toEqual(
      Array.from({ length: HORSE_COUNT }, (_, index) => getHorseId(index)),
    )
    expect(race.horses.some((horse) => horse.id === getHorseId(HORSE_COUNT))).toBe(
      false,
    )
    expect(race.finishOrder).toHaveLength(HORSE_COUNT)
  })
})
