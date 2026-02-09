import { createHash } from 'crypto'
import { PrecomputedRace } from './raceTypes.js'
import type { EventTimeline } from './events/timeline.js'

export function computeRaceChecksum(pre: PrecomputedRace): string {
  const payload = {
    raceId: pre.id,
    seed: pre.config.seed,
    horseSeeds: pre.horses.map((h) => ({
      id: h.id,
      name: h.name,
      baseSpeed: h.baseSpeed,
      accelVariance: h.accelVariance,
      rngSeed: h.rngSeed,
    })),
    // Use canonical finalHorseStateMatrix when available for checksum stability
    firstTickPositions:
      pre.finalHorseStateMatrix?.[0]?.map((p) => p.position) ??
      pre.ticks[0]?.positions.map((p) => p.distance) ??
      [],
    lastTickPositions:
      pre.finalHorseStateMatrix?.[pre.finalHorseStateMatrix.length - 1]?.map(
        (p) => p.position,
      ) ??
      pre.ticks[pre.ticks.length - 1]?.positions.map((p) => p.distance) ??
      [],
    totalTickCount: pre.finalHorseStateMatrix?.length ?? pre.ticks.length,
    finishOrder: pre.finishOrder,
    finishTimesMs: sortFinishTimes(pre.finishTimesMs),
    eventTimelineHash: pre.eventTimeline
      ? computeEventTimelineHash(pre.eventTimeline)
      : null,
  }
  const json = JSON.stringify(payload)
  return createHash('sha256').update(json).digest('hex')
}

function sortFinishTimes(
  times: Record<string, number>,
): ReadonlyArray<readonly [string, number]> {
  const entries = Object.entries(times)
  entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  return Object.freeze(entries.map((e) => Object.freeze([e[0], e[1]] as const)))
}

export function computeEventTimelineHash(tl: EventTimeline): string {
  // Deterministic serialization: sorted tick indices, then sorted by event id+instanceId
  const items: string[] = []
  const ticks = Array.from(tl.keys()).sort((a, b) => a - b)
  for (const t of ticks) {
    const evs = tl.get(t) ?? []
    const ser = evs
      .map((e) => `${e.id}|${e.instanceId}`)
      .sort()
      .join(',')
    items.push(`${t}:${ser}`)
  }
  const payload = items.join(';')
  return createHash('sha256').update(payload).digest('hex')
}
