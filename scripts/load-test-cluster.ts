import { createHarnessConfig } from './load-harness/config.js'
import { runClusterHarness } from './load-harness/clusterCoordinator.js'

void runClusterHarness('baseline', createHarnessConfig('baseline')).catch(
  (error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  },
)
