import { createHarnessConfig } from './load-harness/config.js'
import { runLoadHarness } from './load-harness/runner.js'

void runLoadHarness(createHarnessConfig('baseline')).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
