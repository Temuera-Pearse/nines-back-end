import { promises as fs } from 'fs'
import { join, resolve } from 'path'
import { initPool, verifyPool, closePool } from '../src/db/pool.js'
import { getRaceRepository } from '../src/db/raceRepository.js'
import { getRaceArtifactRepository } from '../src/db/raceArtifactRepository.js'

type SummaryFile = {
  raceId: string
  seed: string
  outcome?: {
    winnerId?: string
    finishOrder?: string[]
    finishTimesMs?: Record<string, number>
  }
  config?: Record<string, unknown>
  checksum?: string
  hasTickStream?: boolean
  hasPrecomputedPaths?: boolean
  eventsCount?: number
}

async function main(): Promise<void> {
  initPool()
  await verifyPool()

  const raceRepository = getRaceRepository()
  const raceArtifactRepository = getRaceArtifactRepository()
  const baseDir = resolve(process.env.RACE_DATA_DIR || 'data/races')
  const entries = await fs.readdir(baseDir, { withFileTypes: true })
  const raceDirs = entries.filter((entry) => entry.isDirectory())

  for (const entry of raceDirs) {
    const dir = join(baseDir, entry.name)
    const summaryPath = join(dir, 'summary.json')

    try {
      const raw = await fs.readFile(summaryPath, 'utf8')
      const summary = JSON.parse(raw) as SummaryFile
      const summaryStat = await fs.stat(summaryPath)

      await raceRepository.upsertSeededRace({
        raceId: summary.raceId,
        seed: summary.seed,
        checksum: summary.checksum ?? null,
        config: summary.config ?? {},
        eventsCount: summary.eventsCount ?? 0,
      })

      await raceRepository.markRaceFinished({
        raceId: summary.raceId,
        actualEndTime: summaryStat.mtime,
        checksum: summary.checksum ?? null,
        winnerId: summary.outcome?.winnerId ?? null,
        finishOrder: summary.outcome?.finishOrder ?? [],
        finishTimesMs: summary.outcome?.finishTimesMs ?? {},
        config: summary.config ?? {},
        hasTickStream: Boolean(summary.hasTickStream),
        hasPrecomputedPaths: Boolean(summary.hasPrecomputedPaths),
        eventsCount: summary.eventsCount ?? 0,
        persistenceStatus: 'saved',
        lifecycleStatus: 'results_showing',
      })

      await raceRepository.markRaceArchived(summary.raceId)

      const artifactCandidates = [
        {
          artifactType: 'summary' as const,
          path: summaryPath,
        },
        {
          artifactType: 'event_timeline' as const,
          path: join(dir, 'eventTimeline.json'),
        },
        {
          artifactType: 'final_horse_state_matrix' as const,
          path: join(dir, 'precomputedPaths.json'),
        },
        {
          artifactType: 'raw_ticks' as const,
          path: join(dir, 'ticks.json'),
        },
      ]

      const artifacts = []
      for (const candidate of artifactCandidates) {
        try {
          const stat = await fs.stat(candidate.path)
          artifacts.push({
            raceId: summary.raceId,
            artifactType: candidate.artifactType,
            storageProvider: 'local_fs' as const,
            storageKey: candidate.path,
            contentType: 'application/json',
            byteSize: stat.size,
            checksum: null,
          })
        } catch {
          // optional artifact missing
        }
      }

      await raceArtifactRepository.upsertArtifacts(artifacts)
      console.log(`Backfilled ${summary.raceId}`)
    } catch (e) {
      console.warn(`Skipping ${entry.name}: ${String(e)}`)
    }
  }
}

void main()
  .catch((e) => {
    console.error(String(e))
    process.exitCode = 1
  })
  .finally(async () => {
    await closePool()
  })
