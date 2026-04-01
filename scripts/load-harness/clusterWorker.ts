import { parentPort, workerData } from 'worker_threads'
import { runLoadHarness } from './runner.js'
import type { LoadHarnessConfig, ReporterEvent } from './types.js'

type WorkerInput = Readonly<{
  workerId: number
  config: LoadHarnessConfig
}>

const input = workerData as WorkerInput

void runLoadHarness(input.config, {
  emit: (event: ReporterEvent) => {
    parentPort?.postMessage({ workerId: input.workerId, event })
  },
})
  .then((summary) => {
    parentPort?.postMessage({ workerId: input.workerId, done: true, summary })
  })
  .catch((error) => {
    parentPort?.postMessage({
      workerId: input.workerId,
      error: error instanceof Error ? error.message : String(error),
    })
    process.exitCode = 1
  })
