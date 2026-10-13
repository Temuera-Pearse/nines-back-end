import { afterEach, describe, expect, it, vi } from 'vitest'

import type { MarkRaceFinishedInput } from '../db/types.js'
import { getRaceRepository } from '../db/raceRepository.js'
import { ImmutableResultEvidenceConflictError } from '../financial/raceResultOutbox.js'
import { RaceWebSocketServer } from '../websocket/wsServer.js'
import { persistAuthoritativeCompletion } from './durableCompletion.js'
import {
  clearRecoveredRaceRuntime,
  seedPrecomputedRace,
  startPrecomputedRace,
  streamPrecomputedTickAt,
  waitForRaceCompletion,
} from './raceEngine.js'
import {
  resetAllocatedRaceRefsForTests,
  type RaceId,
  type RaceRef,
} from './raceId.js'
import { RaceState } from './raceState.js'

const completion: MarkRaceFinishedInput = {
  raceId: 'race-durable-completion',
  actualEndTime: new Date('2026-10-09T12:00:50.000Z'),
  checksum: 'a'.repeat(64),
  winnerId: 'horse-1',
  finishOrder: ['horse-1', 'horse-2'],
  finishTimesMs: { 'horse-1': 19_000 },
  config: { trackLength: 1000, finishRatio: 1, durationMs: 20_000, dtMs: 50 },
  hasTickStream: false,
  hasPrecomputedPaths: false,
  eventsCount: 4,
  persistenceStatus: 'unsaved',
  lifecycleStatus: 'results_showing',
}

describe('durable authoritative completion', () => {
  afterEach(() => {
    delete process.env.NINES_RACE_DATA_PERSISTENCE_ENABLED
    clearRecoveredRaceRuntime()
    resetAllocatedRaceRefsForTests()
    vi.restoreAllMocks()
  })

  it('retries transient persistence failure with identical evidence', async () => {
    const inputs: MarkRaceFinishedInput[] = []
    const repository = { markRaceFinished: vi.fn(async (input: MarkRaceFinishedInput) => {
      inputs.push(input)
      if (inputs.length === 1) throw new Error('connection reset')
    }) }
    const delays: number[] = []

    await persistAuthoritativeCompletion({ repository, input: completion,
      sleep: async (delay) => { delays.push(delay) }, maxAttempts: 3 })

    expect(repository.markRaceFinished).toHaveBeenCalledTimes(2)
    expect(inputs[0]).toBe(completion)
    expect(inputs[1]).toBe(completion)
    expect(delays).toEqual([100])
  })

  it('does not retry immutable evidence conflicts', async () => {
    const repository = { markRaceFinished: vi.fn(async () => {
      throw new ImmutableResultEvidenceConflictError('conflict')
    }) }

    await expect(persistAuthoritativeCompletion({ repository, input: completion,
      sleep: async () => {}, maxAttempts: 3 })).rejects.toThrow('conflict')
    expect(repository.markRaceFinished).toHaveBeenCalledTimes(1)
  })

  it('keeps runtime state and suppresses duplicate finish events until commit', async () => {
    process.env.NINES_RACE_DATA_PERSISTENCE_ENABLED = 'false'
    const repository = getRaceRepository()
    vi.spyOn(repository, 'upsertSeededRace').mockImplementation(async (input) => input.raceRef)
    vi.spyOn(repository, 'markRaceStarted').mockResolvedValue(undefined)
    let commit!: () => void
    const durable = new Promise<void>((resolve) => { commit = resolve })
    const finish = vi.spyOn(repository, 'markRaceFinished').mockReturnValue(durable)
    const messages: Array<{ type?: string }> = []
    vi.spyOn(RaceWebSocketServer, 'broadcast').mockImplementation((message) => {
      messages.push(message as { type?: string })
    })
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    RaceState.setCurrentSeed('durable-completion-engine-test')
    const race = seedPrecomputedRace({
      raceId: () => 'race-durable-completion-engine' as RaceId,
      raceRef: () => 'N9-R2D0R-00001' as RaceRef,
    })
    RaceState.getStateMachine().restoreForRecovery('countdown')
    RaceState.getStateMachine().transition('race_starting')
    startPrecomputedRace(new Date('2026-10-09T12:00:30.000Z'))

    streamPrecomputedTickAt(race.ticks.length - 1)
    streamPrecomputedTickAt(race.ticks.length - 1)
    await Promise.resolve()

    expect(RaceState.getCurrentRace()?.completionState).toBe('persisting')
    expect(RaceState.getPrecomputedRace()?.raceId).toBe(race.raceId)
    expect(messages.filter((message) => message.type === 'race:finish')).toHaveLength(0)

    commit()
    await waitForRaceCompletion(race.raceId)

    expect(finish).toHaveBeenCalledTimes(1)
    expect(RaceState.getCurrentRace()).toBeNull()
    expect(RaceState.getStateMachine().state).toBe('results_showing')
    expect(messages.filter((message) => message.type === 'race:finish')).toHaveLength(1)
  })
})
