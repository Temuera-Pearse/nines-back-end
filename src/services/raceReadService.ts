import { RaceState } from '../race/raceState.js'
import { getRaceRepository } from '../db/raceRepository.js'
import { getRaceArtifactRepository } from '../db/raceArtifactRepository.js'
import type {
  ArtifactType,
  RaceArtifactRecord,
  RaceRecord,
} from '../db/types.js'
import { getRaceArtifactLoader } from './raceArtifactLoader.js'
import type { RaceFinishPayload } from '../race/raceTypes.js'

type TimelineArtifact = Array<{
  tick: number
  events: Array<{ id: string; instanceId: string }>
}>

type FinalTicksArtifact = Array<Array<{ position: number }>>

type SummaryArtifact = {
  authoritativeFinish?: Partial<RaceFinishPayload>
}

function normalizeFinishPayload(
  payload: Partial<RaceFinishPayload> | null | undefined,
): Record<string, unknown> | null {
  if (!payload?.raceId || !payload.winnerId) return null

  const finishOrder = Array.isArray(payload.finishOrder)
    ? payload.finishOrder.filter(
        (horseId): horseId is string => typeof horseId === 'string',
      )
    : []

  const finishTimesMs =
    payload.finishTimesMs && typeof payload.finishTimesMs === 'object'
      ? payload.finishTimesMs
      : {}

  const finishTickIndex =
    payload.finishTickIndex && typeof payload.finishTickIndex === 'object'
      ? payload.finishTickIndex
      : {}

  const presentation =
    payload.presentation && typeof payload.presentation === 'object'
      ? {
          bannerVisibleUntilUtc:
            typeof payload.presentation.bannerVisibleUntilUtc === 'string'
              ? payload.presentation.bannerVisibleUntilUtc
              : '',
          resultsVisibleUntilUtc:
            typeof payload.presentation.resultsVisibleUntilUtc === 'string'
              ? payload.presentation.resultsVisibleUntilUtc
              : '',
        }
      : {
          bannerVisibleUntilUtc: '',
          resultsVisibleUntilUtc: '',
        }

  return {
    raceId: payload.raceId,
    timestampUtc:
      typeof payload.timestampUtc === 'string' ? payload.timestampUtc : '',
    winnerId: payload.winnerId,
    finishOrder,
    finishTimesMs,
    finishTickIndex,
    presentation,
    winner: payload.winnerId,
    placements: [...finishOrder],
  }
}

function mapRaceRecordToSummary(record: RaceRecord) {
  const trackLength = Number(record.config.trackLength ?? 0)
  const finishRatio = Number(record.config.finishRatio ?? 1)
  return {
    raceId: record.raceId,
    config: record.config,
    finishLine:
      Number.isFinite(trackLength) && Number.isFinite(finishRatio)
        ? trackLength * finishRatio
        : null,
    startTime: record.actualStartTime,
    endTime: record.actualEndTime,
    winnerId: record.winnerId,
    finishOrder: record.finishOrder,
    finishTimesMs: record.finishTimesMs,
    checksum: record.checksum,
    lifecycleStatus: record.lifecycleStatus,
    persistenceStatus: record.persistenceStatus,
  }
}

export interface RaceReadService {
  getCurrentRaceSummary(): Promise<Record<string, unknown> | null>
  getPreviousRaceSummary(): Promise<Record<string, unknown> | null>
  getRaceHistory(limit: number): Promise<Record<string, unknown>[]>
  getRaceResults(raceId: string): Promise<Record<string, unknown> | null>
  getTimeline(raceId: string): Promise<TimelineArtifact | null>
  getFinalTicks(
    raceId: string,
  ): Promise<Array<{ tickIndex: number; positions: number[] }> | null>
  getRawTicks(raceId: string): Promise<unknown[] | null>
}

export class DefaultRaceReadService implements RaceReadService {
  private raceRepository = getRaceRepository()
  private raceArtifactRepository = getRaceArtifactRepository()
  private artifactLoader = getRaceArtifactLoader()

  async getCurrentRaceSummary(): Promise<Record<string, unknown> | null> {
    const record = await this.raceRepository.findCurrentRace()
    return record ? mapRaceRecordToSummary(record) : null
  }

  async getPreviousRaceSummary(): Promise<Record<string, unknown> | null> {
    const record = await this.raceRepository.findPreviousRace()
    return record ? mapRaceRecordToSummary(record) : null
  }

  async getRaceHistory(limit: number): Promise<Record<string, unknown>[]> {
    const records = await this.raceRepository.listRaceHistory(limit)
    return records.map(mapRaceRecordToSummary)
  }

  async getRaceResults(
    raceId: string,
  ): Promise<Record<string, unknown> | null> {
    const summaryArtifact = await this.findArtifact(raceId, 'summary')
    if (summaryArtifact) {
      const summary = await this.artifactLoader.loadJson<SummaryArtifact>(
        summaryArtifact,
      )
      const fromSummary = normalizeFinishPayload(summary.authoritativeFinish)
      if (fromSummary) return fromSummary
    }

    const record = await this.raceRepository.findRaceById(raceId)
    if (!record) return null
    return {
      raceId: record.raceId,
      winnerId: record.winnerId,
      finishOrder: record.finishOrder,
      finishTimesMs: record.finishTimesMs,
      finishTickIndex: {},
      presentation: {
        bannerVisibleUntilUtc: '',
        resultsVisibleUntilUtc: '',
      },
      winner: record.winnerId,
      placements: [...record.finishOrder],
    }
  }

  async getTimeline(raceId: string): Promise<TimelineArtifact | null> {
    const pre = RaceState.findPrecomputedById(raceId)
    if (pre?.eventTimeline) {
      const out: TimelineArtifact = []
      for (const [tickIndex, events] of pre.eventTimeline.entries()) {
        out.push({
          tick: tickIndex,
          events: events.map((event) => ({
            id: event.id,
            instanceId: event.instanceId,
          })),
        })
      }
      out.sort((left, right) => left.tick - right.tick)
      return out
    }

    const artifact = await this.findArtifact(raceId, 'event_timeline')
    if (!artifact) return null
    return this.artifactLoader.loadJson<TimelineArtifact>(artifact)
  }

  async getFinalTicks(
    raceId: string,
  ): Promise<Array<{ tickIndex: number; positions: number[] }> | null> {
    const pre = RaceState.findPrecomputedById(raceId)
    if (pre?.finalHorseStateMatrix) {
      return pre.finalHorseStateMatrix.map((states, index) => ({
        tickIndex: index,
        positions: states.map((state) => state.position),
      }))
    }

    const artifact = await this.findArtifact(raceId, 'final_horse_state_matrix')
    if (!artifact) return null
    const matrix =
      await this.artifactLoader.loadJson<FinalTicksArtifact>(artifact)
    return matrix.map((states, index) => ({
      tickIndex: index,
      positions: states.map((state) => Number(state.position ?? 0)),
    }))
  }

  async getRawTicks(raceId: string): Promise<unknown[] | null> {
    const pre = RaceState.findPrecomputedById(raceId)
    if (pre?.ticks) return pre.ticks

    const artifact = await this.findArtifact(raceId, 'raw_ticks')
    if (!artifact) return null
    return this.artifactLoader.loadJson<unknown[]>(artifact)
  }

  private async findArtifact(
    raceId: string,
    artifactType: ArtifactType,
  ): Promise<RaceArtifactRecord | null> {
    return this.raceArtifactRepository.findArtifact(raceId, artifactType)
  }
}

let sharedRaceReadService: RaceReadService | null = null

export function getRaceReadService(): RaceReadService {
  if (!sharedRaceReadService) {
    sharedRaceReadService = new DefaultRaceReadService()
  }
  return sharedRaceReadService
}
