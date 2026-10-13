import type { MarkRaceFinishedInput } from '../db/types.js'
import type { RaceRepository } from '../db/raceRepository.js'
import { ImmutableResultEvidenceConflictError } from '../financial/raceResultOutbox.js'

type CompletionRepository = Pick<RaceRepository, 'markRaceFinished'>

export type DurableCompletionOptions = Readonly<{
  repository: CompletionRepository
  input: MarkRaceFinishedInput
  sleep?: (delayMs: number) => Promise<void>
  maxAttempts?: number
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void
}>

const defaultSleep = (delayMs: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, delayMs))

/** Persist one immutable completion, retrying only failures that may converge. */
export async function persistAuthoritativeCompletion(
  options: DurableCompletionOptions,
): Promise<void> {
  const sleep = options.sleep ?? defaultSleep
  const maxAttempts = options.maxAttempts ?? Number.POSITIVE_INFINITY
  let attempt = 0

  while (attempt < maxAttempts) {
    attempt += 1
    try {
      await options.repository.markRaceFinished(options.input)
      return
    } catch (error) {
      if (error instanceof ImmutableResultEvidenceConflictError) throw error
      if (attempt >= maxAttempts) throw error
      const delayMs = Math.min(5_000, 100 * (2 ** Math.min(attempt - 1, 6)))
      options.onRetry?.(error, attempt, delayMs)
      await sleep(delayMs)
    }
  }
}
