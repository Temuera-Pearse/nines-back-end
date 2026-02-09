import { promises as fs } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { logEvent } from '../utils/logEvent.js'
import type { PrecomputedRace } from '../race/raceTypes.js'
import type { FinalHorseStateMatrix } from '../race/events/effects.js'
import type { EventTimeline, EventInstance } from '../race/events/timeline.js'
import type { WinnerResult } from '../race/winner.js'
// Optional S3 client (loaded only when configured)
let S3ClientRef: any = null
let PutObjectCommandRef: any = null
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const aws = require('@aws-sdk/client-s3')
  S3ClientRef = aws.S3Client
  PutObjectCommandRef = aws.PutObjectCommand
} catch {
  // not installed; local file persistence will be used
}

export type RaceOutcome = Readonly<{
  winnerId: string
  finishOrder: ReadonlyArray<string>
  finishTimesMs: Readonly<Record<string, number>>
}>

export type RaceData = Readonly<{
  raceId: string
  seed: string
  precomputedPaths: FinalHorseStateMatrix | ReadonlyArray<unknown> // allow compacted representation
  tickStream?: ReadonlyArray<unknown> // optional, partial allowed
  eventTimeline: EventTimeline
  outcome: RaceOutcome
  winner: WinnerResult
  // Optional metadata for audit
  config?: PrecomputedRace['config']
  checksum?: string
}>

export interface RacePersistence {
  saveRace(raceId: string, data: RaceData): Promise<void>
  markUnsaved(raceId: string): void
}

/**
 * File-based persistence implementation (JSON).
 * - Async and non-blocking; errors are logged and do not throw to callers by default.
 * - Atomic summary write via a temp file + rename.
 * - Extensible to DB/cloud backends by swapping implementation.
 */
export class FileRacePersistence implements RacePersistence {
  private baseDir: string
  private unsaved = new Set<string>()

  constructor(baseDir = defaultDataDir()) {
    this.baseDir = baseDir
  }

  async saveRace(raceId: string, data: RaceData): Promise<void> {
    // Compose atomic payload (summary + optional tick stream)
    const summary = {
      raceId: data.raceId,
      seed: data.seed,
      outcome: data.outcome,
      winner: data.winner,
      config: data.config ?? undefined,
      checksum: data.checksum ?? undefined,
      // Lightweight references for large arrays
      hasTickStream:
        Array.isArray(data.tickStream) && data.tickStream.length > 0,
      hasPrecomputedPaths:
        Array.isArray(data.precomputedPaths) &&
        data.precomputedPaths.length > 0,
      eventsCount: countEventTimeline(data.eventTimeline),
    }

    const dir = join(this.baseDir, sanitize(raceId))
    const summaryPathTmp = join(dir, 'summary.json.tmp')
    const summaryPath = join(dir, 'summary.json')
    const precompPath = join(dir, 'precomputedPaths.json')
    const timelinePath = join(dir, 'eventTimeline.json')
    const ticksPath = join(dir, 'ticks.json')

    try {
      await fs.mkdir(dir, { recursive: true })

      // Write large payloads first (non-atomic), but failures here should not block summary atomics
      // Precomputed paths
      if (
        Array.isArray(data.precomputedPaths) &&
        data.precomputedPaths.length > 0
      ) {
        try {
          await writeJson(precompPath, data.precomputedPaths)
        } catch (e: any) {
          this.markUnsaved(raceId)
          logEvent('persist:paths-write-error', {
            raceId,
            error: e?.message ?? String(e),
          })
        }
      }

      // Event timeline (serialize to tick-indexed arrays)
      try {
        const serializedTimeline = serializeTimeline(data.eventTimeline)
        await writeJson(timelinePath, serializedTimeline)
      } catch (e: any) {
        this.markUnsaved(raceId)
        logEvent('persist:timeline-write-error', {
          raceId,
          error: e?.message ?? String(e),
        })
      }

      // Optional tick stream (partial allowed)
      if (Array.isArray(data.tickStream) && data.tickStream.length > 0) {
        try {
          await writeJson(ticksPath, data.tickStream)
        } catch (e: any) {
          this.markUnsaved(raceId)
          logEvent('persist:ticks-write-error', {
            raceId,
            error: e?.message ?? String(e),
          })
        }
      }

      // Atomic summary: write to tmp then rename
      await writeJson(summaryPathTmp, summary)
      await fs.rename(summaryPathTmp, summaryPath)

      // Mark race as saved (remove unsaved flag if present)
      if (this.unsaved.has(raceId)) {
        this.unsaved.delete(raceId)
        logEvent('persist:unsaved-cleared', { raceId })
      }
      logEvent('persist:race-saved', { raceId })
    } catch (e: any) {
      // Summary write failure → keep unsaved marker, do not throw to main loop
      this.markUnsaved(raceId)
      try {
        // Clean temp file best-effort
        await fs.rm(summaryPathTmp, { force: true })
      } catch {
        // ignore
      }
      logEvent('persist:summary-write-error', {
        raceId,
        error: e?.message ?? String(e),
      })
    }
  }

  markUnsaved(raceId: string): void {
    if (!this.unsaved.has(raceId)) {
      this.unsaved.add(raceId)
      // Best-effort marker file
      const dir = join(this.baseDir, sanitize(raceId))
      const flagPath = join(dir, 'UNSAVED.flag')
      writeFileBestEffort(flagPath, 'unsaved\n').catch(() => {})
      logEvent('persist:unsaved', { raceId })
    }
  }
}

/**
 * S3-based persistence implementation.
 * Controlled via environment:
 * - PERSIST_S3_BUCKET: bucket name
 * - PERSIST_S3_PREFIX: key prefix (optional)
 */
export class S3RacePersistence implements RacePersistence {
  private bucket: string
  private prefix: string
  private s3: any
  constructor(bucket: string, prefix = '') {
    if (!S3ClientRef || !PutObjectCommandRef) {
      throw new Error('AWS SDK not available; install @aws-sdk/client-s3')
    }
    this.bucket = bucket
    this.prefix = prefix
    this.s3 = new S3ClientRef({})
  }
  async saveRace(raceId: string, data: RaceData): Promise<void> {
    const baseKey = this.keyFor(raceId)
    const summary = {
      raceId: data.raceId,
      seed: data.seed,
      outcome: data.outcome,
      winner: data.winner,
      config: data.config ?? undefined,
      checksum: data.checksum ?? undefined,
      hasTickStream:
        Array.isArray(data.tickStream) && data.tickStream.length > 0,
      hasPrecomputedPaths:
        Array.isArray(data.precomputedPaths) &&
        data.precomputedPaths.length > 0,
      eventsCount: countEventTimeline(data.eventTimeline),
    }
    await this.putJson(`${baseKey}/summary.json`, summary)
    if (
      Array.isArray(data.precomputedPaths) &&
      data.precomputedPaths.length > 0
    ) {
      await this.putJson(
        `${baseKey}/precomputedPaths.json`,
        data.precomputedPaths,
      )
    }
    await this.putJson(
      `${baseKey}/eventTimeline.json`,
      serializeTimeline(data.eventTimeline),
    )
    if (Array.isArray(data.tickStream) && data.tickStream.length > 0) {
      await this.putJson(`${baseKey}/ticks.json`, data.tickStream)
    }
  }
  markUnsaved(_raceId: string): void {
    // No-op for S3; rely on logs/alerts
  }
  private keyFor(raceId: string): string {
    const clean = sanitize(raceId)
    const p = this.prefix ? this.prefix.replace(/\/$/, '') + '/' : ''
    return `${p}${clean}`
  }
  private async putJson(key: string, obj: unknown): Promise<void> {
    const Body = Buffer.from(JSON.stringify(obj))
    const cmd = new PutObjectCommandRef({
      Bucket: this.bucket,
      Key: key,
      Body,
      ContentType: 'application/json',
    })
    await this.s3.send(cmd)
  }
}

export function getRacePersistence(): RacePersistence {
  const bucket = process.env.PERSIST_S3_BUCKET
  if (bucket) {
    const prefix = process.env.PERSIST_S3_PREFIX || 'races'
    try {
      return new S3RacePersistence(bucket, prefix)
    } catch (e) {
      // fallback to file persistence
      logEvent('persist:s3-init-error', {
        error: (e as any)?.message || String(e),
      })
      return new FileRacePersistence()
    }
  }
  return new FileRacePersistence()
}

// ---------- Helpers ----------

function defaultDataDir(): string {
  const base = fileURLToPath(new URL('.', import.meta.url))
  return join(base, '../../data/races')
}

async function writeJson(path: string, obj: unknown): Promise<void> {
  const json = JSON.stringify(obj)
  await fs.writeFile(path, json, 'utf8')
}

async function writeFileBestEffort(
  path: string,
  content: string,
): Promise<void> {
  try {
    await fs.mkdir(dirname(path), { recursive: true })
    await fs.writeFile(path, content, 'utf8')
  } catch {
    // best-effort; ignore
  }
}

function sanitize(id: string): string {
  return id.replace(/[^a-zA-Z0-9-_]/g, '_')
}

function countEventTimeline(tl: EventTimeline): number {
  let count = 0
  for (const arr of tl.values()) count += arr.length
  return count
}

function serializeTimeline(tl: EventTimeline): ReadonlyArray<
  Readonly<{
    tick: number
    events: ReadonlyArray<Pick<EventInstance, 'id' | 'instanceId'>>
  }>
> {
  const out: Array<{
    tick: number
    events: Array<Pick<EventInstance, 'id' | 'instanceId'>>
  }> = []
  for (const [tickIndex, events] of tl.entries()) {
    out.push({
      tick: tickIndex,
      events: events.map((e) => ({ id: e.id, instanceId: e.instanceId })),
    })
  }
  // Keep deterministic order by tick
  out.sort((a, b) => a.tick - b.tick)
  return Object.freeze(
    out.map((x) =>
      Object.freeze({ tick: x.tick, events: Object.freeze(x.events.slice()) }),
    ),
  )
}
