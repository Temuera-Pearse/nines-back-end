import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { activeRaces } from './activeRaceMemory.js'
import { RaceState } from './raceState.js'
import { RaceStateMachine } from './stateMachine.js'

describe('RaceStateMachine mid-cycle seeding', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    process.env.NODE_ENV = 'test'
    RaceState.setPrecomputedRace(null)
    RaceState.setCurrentRace(null)
    RaceState.clearCurrentSeed()
    activeRaces.clear()
  })

  afterEach(() => {
    RaceState.setPrecomputedRace(null)
    RaceState.setCurrentRace(null)
    RaceState.clearCurrentSeed()
    activeRaces.clear()
    vi.useRealTimers()
  })

  it('precomputes a race when first ticking during countdown after the boundary', () => {
    vi.setSystemTime(new Date('2026-06-03T00:00:28.000Z'))
    const stateMachine = new RaceStateMachine()

    expect(() => stateMachine.tick()).not.toThrow()
    expect(RaceState.getCurrentSeed()).toBeTruthy()
    expect(RaceState.getPrecomputedRace()?.id).toBeTruthy()
    expect(stateMachine.getPhaseAndSecond()).toMatchObject({
      phase: 'countdown',
      second: 28,
    })
  })

  it('recovers at race start when precomputed state is missing', () => {
    vi.setSystemTime(new Date('2026-06-03T00:00:29.000Z'))
    const stateMachine = new RaceStateMachine()
    stateMachine.tick()
    RaceState.setPrecomputedRace(null)
    RaceState.clearCurrentSeed()

    vi.setSystemTime(new Date('2026-06-03T00:00:30.000Z'))

    expect(() => stateMachine.tick()).not.toThrow()
    expect(RaceState.getCurrentSeed()).toBeTruthy()
    expect(RaceState.getPrecomputedRace()?.id).toBeTruthy()
    expect(stateMachine.getPhaseAndSecond()).toMatchObject({
      phase: 'race_running',
      second: 30,
    })
  })
})
