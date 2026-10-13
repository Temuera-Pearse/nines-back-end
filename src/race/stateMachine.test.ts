import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { activeRaces } from './activeRaceMemory.js'
import { RaceState } from './raceState.js'
import { seedPrecomputedRace, startPrecomputedRace } from './raceEngine.js'
import { RaceStateMachine } from './stateMachine.js'

describe('RaceStateMachine mid-cycle seeding', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    process.env.NODE_ENV = 'test'
    RaceState.setPrecomputedRace(null)
    RaceState.setCurrentRace(null)
    RaceState.clearCurrentSeed()
    RaceState.getStateMachine().state = 'idle'
    activeRaces.clear()
  })

  afterEach(() => {
    RaceState.setPrecomputedRace(null)
    RaceState.setCurrentRace(null)
    RaceState.clearCurrentSeed()
    RaceState.getStateMachine().state = 'idle'
    activeRaces.clear()
    vi.useRealTimers()
  })

  it('precomputes a race when first ticking during countdown after the boundary', async () => {
    vi.setSystemTime(new Date('2026-06-03T00:00:28.000Z'))
    const stateMachine = new RaceStateMachine()

    await expect(stateMachine.tick()).resolves.toBeUndefined()
    expect(RaceState.getCurrentSeed()).toBeTruthy()
    expect(RaceState.getPrecomputedRace()?.raceId).toBeTruthy()
    expect(stateMachine.getPhaseAndSecond()).toMatchObject({
      phase: 'countdown',
      second: 28,
    })
  })

  it('recovers at race start when precomputed state is missing', async () => {
    vi.setSystemTime(new Date('2026-06-03T00:00:29.000Z'))
    const stateMachine = new RaceStateMachine()
    await stateMachine.tick()
    RaceState.setPrecomputedRace(null)
    RaceState.clearCurrentSeed()

    vi.setSystemTime(new Date('2026-06-03T00:00:30.000Z'))

    await expect(stateMachine.tick()).resolves.toBeUndefined()
    expect(RaceState.getCurrentSeed()).toBeTruthy()
    expect(RaceState.getPrecomputedRace()?.raceId).toBeTruthy()
    expect(stateMachine.getPhaseAndSecond()).toMatchObject({
      phase: 'race_running',
      second: 30,
    })
  })

  it('publishes race_running only after the active runtime race is ready', () => {
    vi.setSystemTime(new Date('2026-06-03T00:00:30.000Z'))
    const stateMachine = RaceState.getStateMachine()
    stateMachine.state = 'race_starting'
    RaceState.setCurrentSeed('race-start-publication-order')
    const seeded = seedPrecomputedRace()
    RaceState.setPrecomputedRace(seeded)

    const runningSnapshots: Array<{
      raceId: string | null
      isActive: boolean | null
    }> = []
    const unsubscribe = stateMachine.subscribe((phase) => {
      if (phase !== 'race_running') return
      const currentRace = RaceState.getCurrentRace()
      runningSnapshots.push({
        raceId: currentRace?.raceId ?? null,
        isActive: currentRace?.isActive ?? null,
      })
    })

    startPrecomputedRace(new Date('2026-06-03T00:00:30.000Z'))
    unsubscribe()

    expect(runningSnapshots).toEqual([
      { raceId: seeded.raceId, isActive: true },
    ])
  })
})
