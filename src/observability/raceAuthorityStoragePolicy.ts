import { getRaceDataPersistencePolicy } from '../persistence/raceDataPersistencePolicy.js'

export function getRaceHistoryLimit(): number {
  const parsed = Number(process.env.NINES_RACE_HISTORY_LIMIT ?? 10)
  if (!Number.isFinite(parsed)) return 10
  return Math.max(1, Math.min(100, Math.floor(parsed)))
}

export function getRaceArtifactStoragePolicy(): {
  persistArtifacts: boolean
  artifactDryRun: boolean
  storageMode: 'simulation' | 'disabled' | 'dry_run' | 'local_fs' | 's3'
  dryRunTarget: string | null
} {
  const policy = getRaceDataPersistencePolicy()
  if (!policy.enabled) {
    return {
      persistArtifacts: false,
      artifactDryRun: false,
      storageMode: policy.source === 'simulation_mode' ? 'simulation' : 'disabled',
      dryRunTarget: null,
    }
  }

  const persistArtifacts = true
  const artifactDryRun = process.env.NINES_ARTIFACT_DRY_RUN === 'true'
  const storageMode = !persistArtifacts
    ? 'disabled'
    : artifactDryRun
      ? 'dry_run'
      : process.env.PERSIST_S3_BUCKET
        ? 's3'
        : 'local_fs'

  return {
    persistArtifacts,
    artifactDryRun,
    storageMode,
    dryRunTarget: artifactDryRun ? storageModeTarget() : null,
  }
}

function storageModeTarget(): string {
  if (process.env.PERSIST_S3_BUCKET) return 's3'
  return 'local_fs'
}
