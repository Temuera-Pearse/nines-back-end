import { afterEach, describe, expect, it, vi } from 'vitest'

import { getRaceRepository } from '../db/raceRepository.js'
import { activeRaces } from './activeRaceMemory.js'
import { releaseRace } from './cleanup.js'
import { RaceState } from './raceState.js'
import type { PrecomputedRace, Race } from './raceTypes.js'

const raceId = 'race-cleanup-transaction'

function installCompletedRuntime(): void {
  const precomputed = {
    raceId,
    raceRef: 'N9-CLNUP-00001',
    ticks: [],
    durationMs: 20_000,
    authoritativeFinish: {
      raceRef: 'N9-CLNUP-00001',
      timestampUtc: '2026-10-09T12:00:50.000Z',
      winnerId: 'horse-1',
      finishOrder: ['horse-1'],
      finishTimesMs: { 'horse-1': 20_000 },
      finishTickIndex: { 'horse-1': 400 },
      presentation: {
        bannerVisibleUntilUtc: '2026-10-09T12:00:53.400Z',
        resultsVisibleUntilUtc: '2026-10-09T12:01:00.000Z',
      },
    },
  } as unknown as PrecomputedRace
  const runtime = {
    raceId,
    horses: [],
    isActive: false,
    placements: [],
    lastBroadcastedTick: 400,
    completionState: 'completed',
  } satisfies Race
  RaceState.setPrecomputedRace(precomputed)
  RaceState.setCurrentRace(runtime)
  activeRaces.set(raceId, {
    ticks: [], startTime: 0, currentTickIndex: 400, winnerDeclaredSent: true,
  })
}

afterEach(() => {
  RaceState.setPrecomputedRace(null)
  RaceState.setCurrentRace(null)
  activeRaces.clear()
  vi.restoreAllMocks()
})

describe('durable race cleanup', () => {
  it('does not clear recoverable runtime until archival commits', async () => {
    installCompletedRuntime()
    let commit!: () => void
    const archival = new Promise<void>((resolve) => { commit = resolve })
    vi.spyOn(getRaceRepository(), 'markRaceArchived').mockReturnValue(archival)

    const cleanup = releaseRace(raceId)
    await Promise.resolve()

    expect(RaceState.getPrecomputedRace()?.raceId).toBe(raceId)
    expect(RaceState.getCurrentRace()?.raceId).toBe(raceId)
    expect(activeRaces.has(raceId)).toBe(true)

    commit()
    await cleanup

    expect(RaceState.getPrecomputedRace()).toBeNull()
    expect(RaceState.getCurrentRace()).toBeNull()
    expect(activeRaces.has(raceId)).toBe(false)
  })

  it('preserves runtime when conditional archival rejects the race', async () => {
    installCompletedRuntime()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(getRaceRepository(), 'markRaceArchived')
      .mockRejectedValue(new Error('race is not durably completed'))

    await expect(releaseRace(raceId)).rejects.toThrow('not durably completed')

    expect(RaceState.getPrecomputedRace()?.raceId).toBe(raceId)
    expect(RaceState.getCurrentRace()?.raceId).toBe(raceId)
    expect(activeRaces.has(raceId)).toBe(true)
  })
})
