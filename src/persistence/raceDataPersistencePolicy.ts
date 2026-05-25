import { logEvent } from '../utils/logEvent.js'
import { isSimulationMode } from '../runtime/simulationMode.js'

export type RaceDataPersistencePolicy = Readonly<{
  enabled: boolean
  envDefaultEnabled: boolean
  source: 'simulation_mode' | 'runtime_override' | 'env_default'
  reason: string | null
  updatedAt: string | null
  updatedBy: string | null
}>

type RuntimeOverride = {
  enabled: boolean
  reason: string | null
  updatedAt: string
  updatedBy: string | null
}

let runtimeOverride: RuntimeOverride | null = null

function envDefaultEnabled(): boolean {
  return process.env.NINES_RACE_DATA_PERSISTENCE_ENABLED === 'true'
}

export function getRaceDataPersistencePolicy(): RaceDataPersistencePolicy {
  const envEnabled = envDefaultEnabled()

  if (isSimulationMode()) {
    return {
      enabled: false,
      envDefaultEnabled: envEnabled,
      source: 'simulation_mode',
      reason: 'NINES_SIMULATION_MODE=true forces race data persistence off',
      updatedAt: runtimeOverride?.updatedAt ?? null,
      updatedBy: runtimeOverride?.updatedBy ?? null,
    }
  }

  if (runtimeOverride) {
    return {
      enabled: runtimeOverride.enabled,
      envDefaultEnabled: envEnabled,
      source: 'runtime_override',
      reason: runtimeOverride.reason,
      updatedAt: runtimeOverride.updatedAt,
      updatedBy: runtimeOverride.updatedBy,
    }
  }

  return {
    enabled: envEnabled,
    envDefaultEnabled: envEnabled,
    source: 'env_default',
    reason: null,
    updatedAt: null,
    updatedBy: null,
  }
}

export function isRaceDataPersistenceEnabled(): boolean {
  return getRaceDataPersistencePolicy().enabled
}

export function setRaceDataPersistenceEnabled(input: {
  enabled: boolean
  reason?: string | null
  updatedBy?: string | null
}): RaceDataPersistencePolicy {
  const before = getRaceDataPersistencePolicy()
  const updatedAt = new Date().toISOString()
  runtimeOverride = {
    enabled: input.enabled,
    reason: input.reason?.trim() || null,
    updatedAt,
    updatedBy: input.updatedBy ?? null,
  }
  const after = getRaceDataPersistencePolicy()

  logEvent('race-data-persistence:policy-changed', {
    beforeEnabled: before.enabled,
    afterEnabled: after.enabled,
    requestedEnabled: input.enabled,
    source: after.source,
    reason: after.reason,
    updatedBy: after.updatedBy,
  })

  return after
}

export function resetRaceDataPersistencePolicyForTests(): void {
  runtimeOverride = null
}
