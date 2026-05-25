import type { RacePhase } from '../race/stateMachine.js'
import type { RacePersistenceStatus } from '../db/types.js'

export type RaceAuthorityTransitionSnapshot = Readonly<{
  phase: RacePhase
  second: number
  transitionedAt: string
  driftMs: number | null
}>

export type RaceAuthorityArtifactWriteSnapshot = Readonly<{
  raceId: string
  status: RacePersistenceStatus | 'disabled' | 'dry_run'
  wroteArtifacts: boolean
  artifactCountsByType: Record<string, number>
  artifactsTotal: number
  eventsCount: number
  hasPrecomputedPaths: boolean
  hasTickStream: boolean
  storageMode: 'simulation' | 'disabled' | 'dry_run' | 'local_fs' | 's3'
  writtenAt: string
  error: string | null
}>

type MutableSignals = {
  transitionsByPhase: Partial<Record<RacePhase, RaceAuthorityTransitionSnapshot>>
  lastTransition: RaceAuthorityTransitionSnapshot | null
  lastLifecycleTickDriftMs: number | null
  lastEngineError: { message: string; at: string } | null
  lastWatchdogWarning: { message: string; at: string; raceId?: string } | null
  lastArtifactWrite: RaceAuthorityArtifactWriteSnapshot | null
}

const transitionStartSecond: Record<RacePhase, number> = {
  idle: 59,
  countdown: 27,
  race_starting: 29,
  race_running: 30,
  race_finished: 51,
  results_showing: 51,
}

const signals: MutableSignals = {
  transitionsByPhase: {},
  lastTransition: null,
  lastLifecycleTickDriftMs: null,
  lastEngineError: null,
  lastWatchdogWarning: null,
  lastArtifactWrite: null,
}

let unsubscribeStateMachine: (() => void) | null = null
let lastObservedPhase: RacePhase | null = null

function transitionDriftMs(phase: RacePhase): number | null {
  const now = new Date()
  const scheduledSecond = transitionStartSecond[phase]
  const scheduled = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    now.getUTCHours(),
    now.getUTCMinutes(),
    scheduledSecond,
    0,
  )
  return now.getTime() - scheduled
}

export function observeRaceStateMachine(stateMachine: {
  subscribe(fn: (phase: RacePhase, second: number, data?: unknown) => void): () => void
}): void {
  if (unsubscribeStateMachine) return
  unsubscribeStateMachine = stateMachine.subscribe((phase, second) => {
    if (phase === lastObservedPhase) return
    lastObservedPhase = phase
    const snapshot: RaceAuthorityTransitionSnapshot = {
      phase,
      second,
      transitionedAt: new Date().toISOString(),
      driftMs: transitionDriftMs(phase),
    }
    signals.transitionsByPhase[phase] = snapshot
    signals.lastTransition = snapshot
  })
}

export function stopRaceAuthoritySignalObservation(): void {
  if (!unsubscribeStateMachine) return
  unsubscribeStateMachine()
  unsubscribeStateMachine = null
  lastObservedPhase = null
}

export function recordLifecycleTickDrift(driftMs: number): void {
  signals.lastLifecycleTickDriftMs = Number(driftMs.toFixed(2))
}

export function recordEngineError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  signals.lastEngineError = {
    message,
    at: new Date().toISOString(),
  }
}

export function recordWatchdogWarning(message: string, raceId?: string): void {
  signals.lastWatchdogWarning = {
    message,
    at: new Date().toISOString(),
    raceId,
  }
}

export function recordArtifactWrite(
  snapshot: Omit<RaceAuthorityArtifactWriteSnapshot, 'writtenAt'>,
): void {
  signals.lastArtifactWrite = {
    ...snapshot,
    writtenAt: new Date().toISOString(),
  }
}

export function getRaceAuthoritySignals(): Readonly<MutableSignals> {
  return {
    transitionsByPhase: { ...signals.transitionsByPhase },
    lastTransition: signals.lastTransition,
    lastLifecycleTickDriftMs: signals.lastLifecycleTickDriftMs,
    lastEngineError: signals.lastEngineError,
    lastWatchdogWarning: signals.lastWatchdogWarning,
    lastArtifactWrite: signals.lastArtifactWrite,
  }
}
