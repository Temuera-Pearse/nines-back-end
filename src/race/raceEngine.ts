import { Race, Horse } from './raceTypes.js'
import {
  RaceConfig,
  HorseSeed,
  PrecomputedRace,
  PrecomputedTick,
  PositionUpdate,
  Race,
} from './raceTypes.js'
import { RaceWebSocketServer } from '../websocket/wsServer.js'
import { makeSeededRng, hashStringToInt } from './rng.js'

export const TRACK_LENGTH = 100

const VERBOSE = process.env.LOG_VERBOSE === 'true'
const ts = () => new Date().toISOString()
const log = (...args: any[]) => console.log(...args)

let currentRace: Race | null = null
let precomputed: PrecomputedRace | null = null
let lastStreamedIndex: number | null = null

function generateHorseSeeds(numHorses: number, raceSeed: string): HorseSeed[] {
  const base = hashStringToInt(raceSeed)
  const rng = makeSeededRng(base)
  const horses: HorseSeed[] = []
  for (let i = 0; i < numHorses; i++) {
    const minSpeed = 2.0 + rng() * 1.0
    const maxSpeed = minSpeed + 2.0 + rng() * 1.5
    const baseSpeed = (minSpeed + maxSpeed) / 2
    const accelVariance = 0.6 + rng() * 0.6
    horses.push({
      id: `horse-${i}`,
      name: `Horse ${i + 1}`,
      baseSpeed,
      accelVariance,
      rngSeed: (base + i * 9973) >>> 0,
    })
  }
  return horses
}

export function generateRaceTicks(
  horses: HorseSeed[],
  config: RaceConfig
): {
  ticks: PrecomputedTick[]
  finishOrder: string[]
  finishTimesMs: Record<string, number>
  winnerId: string
} {
  const raceId = config.seed
  const finishLine = config.trackLength * config.finishRatio
  const totalFrames = Math.floor(config.durationMs / config.dtMs)

  const perHorseRng = horses.reduce<Record<string, () => number>>((acc, h) => {
    acc[h.id] = makeSeededRng(h.rngSeed)
    return acc
  }, {})

  const positions: Record<string, number> = {}
  const speeds: Record<string, number> = {}
  const finishTimesMs: Record<string, number> = {}
  const finishedSet = new Set<string>()

  horses.forEach((h) => {
    positions[h.id] = 0
    speeds[h.id] = h.baseSpeed
  })

  log(
    `[${ts()}][RACE][${raceId}] Precompute begin. finishLine=${finishLine.toFixed(
      2
    )} track=${config.trackLength}m duration=${config.durationMs}ms dt=${
      config.dtMs
    }ms`
  )
  log(
    `[${ts()}][TICKS][${raceId}] Precomputing ${
      totalFrames + 1
    } ticks with seed=${config.seed}`
  )
  if (VERBOSE) {
    horses.forEach((h) =>
      log(
        `[${ts()}][HORSE][${raceId}] Horse-${
          h.id
        } start position=0.00 baseSpeed=${h.baseSpeed.toFixed(
          2
        )} accelVar=${h.accelVariance.toFixed(2)}`
      )
    )
  }

  const ticks: PrecomputedTick[] = []

  for (let frame = 0; frame <= totalFrames; frame++) {
    const tMs = frame * config.dtMs
    let crossedThisTick = false
    const framePositions: Array<{ horseId: string; distance: number }> = []

    horses.forEach((h) => {
      const prevSpeed = speeds[h.id]
      if (finishedSet.has(h.id)) {
        framePositions.push({ horseId: h.id, distance: positions[h.id] })
        return
      }

      // Accel model
      const r = perHorseRng[h.id]()
      const accel = (r - 0.5) * 2 * h.accelVariance

      // Speed clamped between 0.5 and a soft cap
      const maxCap = h.baseSpeed + h.accelVariance * 2
      let nextSpeed = h.baseSpeed + accel
      const clampedSpeed = Math.min(Math.max(0.5, nextSpeed), maxCap)
      speeds[h.id] = clampedSpeed
      const deltaSpeed = clampedSpeed - prevSpeed

      // Distance integration
      const deltaDist = (clampedSpeed * config.dtMs) / 1000
      const before = positions[h.id]
      positions[h.id] = Math.min(config.trackLength, before + deltaDist)

      // Horse state logs
      if (VERBOSE) {
        const accelState = accel >= 0 ? 'ACCEL' : 'BRAKE'
        log(
          `[${ts()}][HORSE][${raceId}] Horse-${
            h.id
          } ${accelState} accel=${accel.toFixed(
            2
          )} speed=${clampedSpeed.toFixed(2)} deltaSpeed=${deltaSpeed.toFixed(
            2
          )} distance=${positions[h.id].toFixed(2)}`
        )
        if (clampedSpeed === maxCap) {
          log(
            `[${ts()}][HORSE][${raceId}] Horse-${
              h.id
            } HIT_MAX_SPEED cap=${maxCap.toFixed(2)}`
          )
        }
        if (clampedSpeed === 0.5) {
          log(`[${ts()}][HORSE][${raceId}] Horse-${h.id} HIT_MIN_SPEED 0.50`)
        }
      }

      // Finish crossing
      if (!finishTimesMs[h.id] && positions[h.id] >= finishLine) {
        finishTimesMs[h.id] = tMs
        finishedSet.add(h.id)
        crossedThisTick = true
        log(
          `[${ts()}][HORSE][${raceId}] Horse-${h.id} FINISHED at ${(
            tMs / 1000
          ).toFixed(2)}s distance=${positions[h.id].toFixed(2)}`
        )
      }

      framePositions.push({ horseId: h.id, distance: positions[h.id] })
    })

    // Tick summary log
    if (VERBOSE) {
      const distSummary = horses
        .map((h) => `H${h.id}:${positions[h.id].toFixed(2)}`)
        .join(' | ')
      log(
        `[${ts()}][TICK][${raceId}] Tick ${frame}/${totalFrames} elapsed=${tMs}ms | ${distSummary} | crossed=${crossedThisTick}`
      )
    }

    ticks.push({
      timestampOffsetMs: tMs,
      positions: framePositions,
    })
  }

  // Determine finish order
  const finishOrder = [...horses]
    .sort((a, b) => {
      const ta = finishTimesMs[a.id] ?? Number.POSITIVE_INFINITY
      const tb = finishTimesMs[b.id] ?? Number.POSITIVE_INFINITY
      if (ta !== tb) return ta - tb
      return positions[b.id] - positions[a.id]
    })
    .map((h) => h.id)

  const winnerId = finishOrder[0]
  const sampleFirst = ticks.slice(0, 3)
  const sampleLast = ticks.slice(-3)
  log(
    `[${ts()}][TICKS][${raceId}] Sample ticks: first3=${JSON.stringify(
      sampleFirst
    )} last3=${JSON.stringify(sampleLast)}`
  )
  log(
    `[${ts()}][RACE][${raceId}] Projected finish times (ms): ${JSON.stringify(
      finishTimesMs
    )}`
  )
  log(`[${ts()}][RACE][${raceId}] Precompute complete. Winner=${winnerId}`)

  return { ticks, finishOrder, finishTimesMs, winnerId }
}

// Seeds and stores a precomputed race (call shortly before :30)
export function seedPrecomputedRace(now = new Date()): PrecomputedRace {
  const raceId = `race-${now.getTime()}`
  const config: RaceConfig = {
    trackLength: TRACK_LENGTH,
    finishRatio: 0.9,
    durationMs: 20000,
    dtMs: 50,
    seed: raceId,
  }
  const horses = generateHorseSeeds(10, config.seed)
  const { ticks, finishOrder, finishTimesMs, winnerId } = generateRaceTicks(
    horses,
    config
  )
  const finishLine = config.trackLength * config.finishRatio

  precomputed = {
    id: raceId,
    config,
    horses,
    ticks,
    finishLine,
    winnerId,
    finishOrder,
    finishTimesMs,
  }

  lastStreamedIndex = null

  log(`[${ts()}][RACE][${raceId}] Seeded race`, {
    raceId,
    trackLength: config.trackLength,
    finishLine,
    durationMs: config.durationMs,
    dtMs: config.dtMs,
    winnerId,
  })

  return precomputed
}

// Starts the race (binds real-world clock to precomputed ticks)
export function startPrecomputedRace(startTime = new Date()): PrecomputedRace {
  if (!precomputed) {
    precomputed = seedPrecomputedRace(startTime)
  }
  precomputed.startTime = startTime
  log(
    `[${ts()}][RACE][${
      precomputed.id
    }] Race started at ${startTime.toISOString()}`
  )

  currentRace = {
    id: precomputed.id,
    horses: precomputed.horses.map((h) => ({
      id: h.id,
      name: h.name,
      position: 0,
      minSpeed: h.baseSpeed,
      maxSpeed: h.baseSpeed,
    })),
    isActive: true,
    placements: [],
    winner: undefined,
  }

  RaceWebSocketServer.broadcast({
    type: 'race:start',
    data: { raceId: precomputed.id, horses: currentRace.horses },
  })
  return precomputed
}

// Stream ticks in real time based on startTime and dtMs
export function streamPrecomputedTicks(now = new Date()): PositionUpdate[] {
  if (!precomputed?.startTime || !currentRace?.isActive) {
    throw new Error('No active precomputed race')
  }
  const elapsedMs = now.getTime() - precomputed.startTime.getTime()
  const idx = closestTickIndex(precomputed.ticks, elapsedMs)
  const best = precomputed.ticks[idx]
  const driftMs = elapsedMs - best.timestampOffsetMs

  // Sync/drift logs
  if (Math.abs(driftMs) > precomputed.config.dtMs / 2) {
    log(
      `[${ts()}][SYNC][${
        precomputed.id
      }] Drift=${driftMs}ms (elapsed=${elapsedMs}ms, tickTs=${
        best.timestampOffsetMs
      }ms)`
    )
  }
  if (lastStreamedIndex !== null && idx - lastStreamedIndex > 1) {
    const skipped = idx - lastStreamedIndex - 1
    log(
      `[${ts()}][SYNC][${
        precomputed.id
      }] Skipped ${skipped} intermediate ticks (last=${lastStreamedIndex}, now=${idx})`
    )
  }
  lastStreamedIndex = idx

  const updates: PositionUpdate[] = best.positions.map((p) => ({
    horseId: p.horseId,
    position: p.distance,
  }))

  log(
    `[${ts()}][TICK][${
      precomputed.id
    }] Stream tick index=${idx} elapsed=${elapsedMs}ms`
  )

  RaceWebSocketServer.broadcast({
    type: 'race:tick',
    data: updates,
  })

  const raceDurationOver = elapsedMs >= precomputed.config.durationMs
  const winnerId = precomputed.winnerId
  if (raceDurationOver && winnerId && currentRace.isActive) {
    currentRace.isActive = false
    currentRace.placements = precomputed.finishOrder.map((id) => {
      const h = currentRace!.horses.find((hh) => hh.id === id)!
      return h
    })
    currentRace.winner = currentRace.placements[0]
    precomputed.endTime = now

    log(`[${ts()}][RACE][${precomputed.id}] Race finished. Winner=${winnerId}`)

    RaceWebSocketServer.broadcast({
      type: 'race:finish',
      data: { winner: currentRace.winner!, placements: currentRace.placements },
    })
  }

  return updates
}

function closestTickIndex(ticks: PrecomputedTick[], elapsedMs: number): number {
  // linear search is fine for ~400 frames
  let bestIdx = 0
  let bestDiff = Math.abs(elapsedMs - ticks[0].timestampOffsetMs)
  for (let i = 1; i < ticks.length; i++) {
    const d = Math.abs(elapsedMs - ticks[i].timestampOffsetMs)
    if (d < bestDiff) {
      bestIdx = i
      bestDiff = d
    }
  }
  return bestIdx
}
