import { promises as fs } from 'fs'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'
import { logEvent } from '../utils/logEvent.js'
import type { ArtifactType, StorageProvider } from '../db/types.js'
import type { PrecomputedRace, RaceFinishPayload } from '../race/raceTypes.js'
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
  authoritativeFinish: RaceFinishPayload
  precomputedPaths: FinalHorseStateMatrix | ReadonlyArray<unknown> // allow compacted representation
  tickStream?: ReadonlyArray<unknown> // optional, partial allowed
  eventTimeline: EventTimeline
  outcome: RaceOutcome
  winner: WinnerResult
  // Optional metadata for audit
  config?: PrecomputedRace['config']
  checksum?: string
}>

export type PersistenceStatus = 'saved' | 'partial' | 'unsaved'

export type PersistedArtifactDescriptor = Readonly<{
  artifactType: ArtifactType
  storageProvider: StorageProvider
  storageKey: string
  contentType: string
  byteSize?: number
  checksum?: string
}>

export type SaveRaceResult = Readonly<{
  persistenceStatus: PersistenceStatus
  artifacts: ReadonlyArray<PersistedArtifactDescriptor>
  hasPrecomputedPaths: boolean
  hasTickStream: boolean
  eventsCount: number
}>

export interface RacePersistence {
  saveRace(raceId: string, data: RaceData): Promise<SaveRaceResult>
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

  async saveRace(raceId: string, data: RaceData): Promise<SaveRaceResult> {
    // Compose atomic payload (summary + optional tick stream)
    const hasTickStream =
      Array.isArray(data.tickStream) && data.tickStream.length > 0
    const hasPrecomputedPaths =
      Array.isArray(data.precomputedPaths) && data.precomputedPaths.length > 0
    const eventsCount = countEventTimeline(data.eventTimeline)
    const summary = {
      raceId: data.raceId,
      seed: data.seed,
      authoritativeFinish: data.authoritativeFinish,
      outcome: data.outcome,
      winner: data.winner,
      config: data.config ?? undefined,
      checksum: data.checksum ?? undefined,
      // Lightweight references for large arrays
      hasTickStream,
      hasPrecomputedPaths,
      eventsCount,
    }

    const dir = join(this.baseDir, sanitize(raceId))
    const summaryPathTmp = join(dir, 'summary.json.tmp')
    const summaryPath = join(dir, 'summary.json')
    const precompPath = join(dir, 'precomputedPaths.json')
    const timelinePath = join(dir, 'eventTimeline.json')
    const ticksPath = join(dir, 'ticks.json')
    const artifacts: PersistedArtifactDescriptor[] = []
    let hadFailure = false

    try {
      await fs.mkdir(dir, { recursive: true })

      // Write large payloads first (non-atomic), but failures here should not block summary atomics
      // Precomputed paths
      if (hasPrecomputedPaths) {
        try {
          const byteSize = await writeJson(precompPath, data.precomputedPaths)
          artifacts.push({
            artifactType: 'final_horse_state_matrix',
            storageProvider: 'local_fs',
            storageKey: precompPath,
            contentType: 'application/json',
            byteSize,
          })
        } catch (e: any) {
          hadFailure = true
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
        const byteSize = await writeJson(timelinePath, serializedTimeline)
        artifacts.push({
          artifactType: 'event_timeline',
          storageProvider: 'local_fs',
          storageKey: timelinePath,
          contentType: 'application/json',
          byteSize,
        })
      } catch (e: any) {
        hadFailure = true
        this.markUnsaved(raceId)
        logEvent('persist:timeline-write-error', {
          raceId,
          error: e?.message ?? String(e),
        })
      }

      // Optional tick stream (partial allowed)
      if (hasTickStream) {
        try {
          const byteSize = await writeJson(ticksPath, data.tickStream)
          artifacts.push({
            artifactType: 'raw_ticks',
            storageProvider: 'local_fs',
            storageKey: ticksPath,
            contentType: 'application/json',
            byteSize,
          })
        } catch (e: any) {
          hadFailure = true
          this.markUnsaved(raceId)
          logEvent('persist:ticks-write-error', {
            raceId,
            error: e?.message ?? String(e),
          })
        }
      }

      // Atomic summary: write to tmp then rename
      const summaryByteSize = await writeJson(summaryPathTmp, summary)
      await fs.rename(summaryPathTmp, summaryPath)
      artifacts.unshift({
        artifactType: 'summary',
        storageProvider: 'local_fs',
        storageKey: summaryPath,
        contentType: 'application/json',
        byteSize: summaryByteSize,
      })

      // Mark race as saved (remove unsaved flag if present)
      if (this.unsaved.has(raceId)) {
        this.unsaved.delete(raceId)
        logEvent('persist:unsaved-cleared', { raceId })
      }
      logEvent('persist:race-saved', { raceId })
      return {
        persistenceStatus: hadFailure ? 'partial' : 'saved',
        artifacts,
        hasPrecomputedPaths,
        hasTickStream,
        eventsCount,
      }
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
      return {
        persistenceStatus: 'unsaved',
        artifacts,
        hasPrecomputedPaths,
        hasTickStream,
        eventsCount,
      }
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
  async saveRace(raceId: string, data: RaceData): Promise<SaveRaceResult> {
    const baseKey = this.keyFor(raceId)
    const hasTickStream =
      Array.isArray(data.tickStream) && data.tickStream.length > 0
    const hasPrecomputedPaths =
      Array.isArray(data.precomputedPaths) && data.precomputedPaths.length > 0
    const eventsCount = countEventTimeline(data.eventTimeline)
    const summary = {
      raceId: data.raceId,
      seed: data.seed,
      authoritativeFinish: data.authoritativeFinish,
      outcome: data.outcome,
      winner: data.winner,
      config: data.config ?? undefined,
      checksum: data.checksum ?? undefined,
      hasTickStream,
      hasPrecomputedPaths,
      eventsCount,
    }
    const artifacts: PersistedArtifactDescriptor[] = []
    let hadFailure = false

    try {
      const summaryKey = `${baseKey}/summary.json`
      const summaryByteSize = await this.putJson(summaryKey, summary)
      artifacts.push({
        artifactType: 'summary',
        storageProvider: 's3',
        storageKey: summaryKey,
        contentType: 'application/json',
        byteSize: summaryByteSize,
      })

      if (hasPrecomputedPaths) {
        try {
          const key = `${baseKey}/precomputedPaths.json`
          const byteSize = await this.putJson(key, data.precomputedPaths)
          artifacts.push({
            artifactType: 'final_horse_state_matrix',
            storageProvider: 's3',
            storageKey: key,
            contentType: 'application/json',
            byteSize,
          })
        } catch {
          hadFailure = true
        }
      }

      try {
        const key = `${baseKey}/eventTimeline.json`
        const byteSize = await this.putJson(
          key,
          serializeTimeline(data.eventTimeline),
        )
        artifacts.push({
          artifactType: 'event_timeline',
          storageProvider: 's3',
          storageKey: key,
          contentType: 'application/json',
          byteSize,
        })
      } catch {
        hadFailure = true
      }

      if (hasTickStream) {
        try {
          const key = `${baseKey}/ticks.json`
          const byteSize = await this.putJson(key, data.tickStream)
          artifacts.push({
            artifactType: 'raw_ticks',
            storageProvider: 's3',
            storageKey: key,
            contentType: 'application/json',
            byteSize,
          })
        } catch {
          hadFailure = true
        }
      }

      return {
        persistenceStatus: hadFailure ? 'partial' : 'saved',
        artifacts,
        hasPrecomputedPaths,
        hasTickStream,
        eventsCount,
      }
    } catch {
      return {
        persistenceStatus: 'unsaved',
        artifacts,
        hasPrecomputedPaths,
        hasTickStream,
        eventsCount,
      }
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
  private async putJson(key: string, obj: unknown): Promise<number> {
    const Body = Buffer.from(JSON.stringify(obj))
    const cmd = new PutObjectCommandRef({
      Bucket: this.bucket,
      Key: key,
      Body,
      ContentType: 'application/json',
    })
    await this.s3.send(cmd)
    return Body.byteLength
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
  if (process.env.RACE_DATA_DIR) {
    return resolve(process.env.RACE_DATA_DIR)
  }
  const base = fileURLToPath(new URL('.', import.meta.url))
  return join(base, '../../data/races')
}

async function writeJson(path: string, obj: unknown): Promise<number> {
  const json = JSON.stringify(obj)
  await fs.writeFile(path, json, 'utf8')
  return Buffer.byteLength(json)
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
