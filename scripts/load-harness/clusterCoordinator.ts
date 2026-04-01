import { Worker } from 'worker_threads'
import { JsonReporter } from './reporter.js'
import { evaluateOperationalVerdict } from './evaluation.js'
import type {
  FinalSummary,
  LoadHarnessConfig,
  ReporterEvent,
  ScenarioMode,
} from './types.js'

function average(total: number, count: number): number {
  return count === 0 ? 0 : total / count
}

function mergeSummaries(
  scenario: ScenarioMode,
  config: LoadHarnessConfig,
  summaries: FinalSummary[],
): FinalSummary {
  const startedAt = summaries
    .map((summary) => Date.parse(summary.startedAt))
    .reduce((min, value) => Math.min(min, value), Number.POSITIVE_INFINITY)
  const finishedAt = summaries
    .map((summary) => Date.parse(summary.finishedAt))
    .reduce((max, value) => Math.max(max, value), 0)
  const framesTotal = summaries.reduce(
    (sum, summary) => sum + summary.framesTotal,
    0,
  )
  const weightedLatency = summaries.reduce(
    (sum, summary) => sum + summary.averageLatencyMs * summary.framesTotal,
    0,
  )
  const reconnectAttempts = summaries.reduce(
    (sum, summary) => sum + summary.reconnectAttempts,
    0,
  )
  const reconnectSuccesses = summaries.reduce(
    (sum, summary) => sum + summary.reconnectSuccesses,
    0,
  )
  const syncCount = summaries.reduce(
    (sum, summary) => sum + summary.syncCount,
    0,
  )
  const syncLatencyWeighted = summaries.reduce(
    (sum, summary) => sum + summary.syncLatencyAvgMs * summary.syncCount,
    0,
  )
  const durationMs = Math.max(0, finishedAt - startedAt)
  const anomaliesByType = new Map<string, number>()
  for (const summary of summaries) {
    for (const [type, count] of Object.entries(summary.anomaliesByType)) {
      anomaliesByType.set(type, (anomaliesByType.get(type) ?? 0) + count)
    }
  }

  const perRaceMap = new Map<
    string,
    { clientsFinished: number; resultsValidated: number; mismatches: number }
  >()
  for (const summary of summaries) {
    for (const race of summary.perRace) {
      const current = perRaceMap.get(race.raceId) ?? {
        clientsFinished: 0,
        resultsValidated: 0,
        mismatches: 0,
      }
      current.clientsFinished += race.clientsFinished
      current.resultsValidated += race.resultsValidated
      current.mismatches += race.mismatches
      perRaceMap.set(race.raceId, current)
    }
  }

  const worstClients = summaries
    .flatMap((summary) => summary.worstClients)
    .sort((left, right) => {
      if (right.seqGaps !== left.seqGaps) return right.seqGaps - left.seqGaps
      if (right.droppedFrames !== left.droppedFrames)
        return right.droppedFrames - left.droppedFrames
      return right.latencyMaxMs - left.latencyMaxMs
    })
    .slice(0, summaries[0]?.worstClients.length ?? 10)

  const baseSummary = Object.freeze({
    scenario,
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date(finishedAt).toISOString(),
    durationMs,
    totalClients: summaries.reduce(
      (sum, summary) => sum + summary.totalClients,
      0,
    ),
    transportMode: summaries[0]?.transportMode ?? 'plain',
    binary: summaries[0]?.binary ?? false,
    connectedPeak: summaries.reduce(
      (sum, summary) => sum + summary.connectedPeak,
      0,
    ),
    framesTotal,
    messagesPerSecondAvg: average(framesTotal * 1000, Math.max(1, durationMs)),
    averageLatencyMs: average(weightedLatency, framesTotal),
    p95LatencyMs: summaries.reduce(
      (max, summary) => Math.max(max, summary.p95LatencyMs),
      0,
    ),
    worstLatencyMs: summaries.reduce(
      (max, summary) => Math.max(max, summary.worstLatencyMs),
      0,
    ),
    droppedFrames: summaries.reduce(
      (sum, summary) => sum + summary.droppedFrames,
      0,
    ),
    seqGaps: summaries.reduce((sum, summary) => sum + summary.seqGaps, 0),
    seqGapFrames: summaries.reduce(
      (sum, summary) => sum + summary.seqGapFrames,
      0,
    ),
    seqRegressions: summaries.reduce(
      (sum, summary) => sum + summary.seqRegressions,
      0,
    ),
    reconnectAttempts,
    reconnectSuccesses,
    reconnectSuccessRate: average(reconnectSuccesses, reconnectAttempts),
    syncCount,
    syncLatencyAvgMs: average(syncLatencyWeighted, syncCount),
    syncLatencyP95Ms: summaries.reduce(
      (max, summary) => Math.max(max, summary.syncLatencyP95Ms),
      0,
    ),
    racesFinished: summaries.reduce(
      (sum, summary) => sum + summary.racesFinished,
      0,
    ),
    resultsValidated: summaries.reduce(
      (sum, summary) => sum + summary.resultsValidated,
      0,
    ),
    resultMismatches: summaries.reduce(
      (sum, summary) => sum + summary.resultMismatches,
      0,
    ),
    anomalyCount: summaries.reduce(
      (sum, summary) => sum + summary.anomalyCount,
      0,
    ),
    anomaliesByType: Object.freeze(
      Object.fromEntries(anomaliesByType.entries()),
    ),
    eventLoopLagMeanMs: average(
      summaries.reduce(
        (sum, summary) => sum + summary.eventLoopLagMeanMs * summary.durationMs,
        0,
      ),
      summaries.reduce((sum, summary) => sum + summary.durationMs, 0),
    ),
    eventLoopLagP95Ms: summaries.reduce(
      (max, summary) => Math.max(max, summary.eventLoopLagP95Ms),
      0,
    ),
    eventLoopLagMaxMs: summaries.reduce(
      (max, summary) => Math.max(max, summary.eventLoopLagMaxMs),
      0,
    ),
    harnessMemoryGrowthMb: summaries.reduce(
      (sum, summary) => sum + summary.harnessMemoryGrowthMb,
      0,
    ),
    harnessMemoryGrowthPercent: summaries.reduce(
      (max, summary) => Math.max(max, summary.harnessMemoryGrowthPercent),
      0,
    ),
    serverResidentMemoryStartMb: firstDefined(
      summaries.map((summary) => summary.serverResidentMemoryStartMb),
    ),
    serverResidentMemoryEndMb: lastDefined(
      summaries.map((summary) => summary.serverResidentMemoryEndMb),
    ),
    serverResidentMemoryGrowthMb: maxDefined(
      summaries.map((summary) => summary.serverResidentMemoryGrowthMb),
    ),
    serverResidentMemoryGrowthPercent: maxDefined(
      summaries.map((summary) => summary.serverResidentMemoryGrowthPercent),
    ),
    maxServerTickCpuAvgMs: maxDefined(
      summaries.map((summary) => summary.maxServerTickCpuAvgMs),
    ),
    maxServerCatchupP95Ms: maxDefined(
      summaries.map((summary) => summary.maxServerCatchupP95Ms),
    ),
    maxServerFanoutP95Ms: maxDefined(
      summaries.map((summary) => summary.maxServerFanoutP95Ms),
    ),
    verdict: 'PASS' as const,
    thresholdResults: Object.freeze([]),
    topIssues: Object.freeze([]),
    firstFailedMetric: undefined,
    investigateNext: undefined,
    perRace: Object.freeze(
      Array.from(perRaceMap.entries()).map(([raceId, race]) => ({
        raceId,
        ...race,
      })),
    ),
    worstClients: Object.freeze(worstClients),
    latestServerMetrics:
      summaries.map((summary) => summary.latestServerMetrics).find(Boolean) ??
      undefined,
  })
  const evaluation = evaluateOperationalVerdict(baseSummary, config)

  return Object.freeze({
    ...baseSummary,
    verdict: evaluation.verdict,
    thresholdResults: evaluation.thresholdResults,
    topIssues: evaluation.topIssues,
    firstFailedMetric: evaluation.firstFailedMetric,
    investigateNext: evaluation.investigateNext,
  })
}

export async function runClusterHarness(
  scenario: ScenarioMode,
  config: LoadHarnessConfig,
): Promise<FinalSummary> {
  const perWorker = Math.max(1, Number(process.env.PER_WORKER || 500))
  const workerCount = Math.max(1, Math.ceil(config.clients / perWorker))
  const reporter = new JsonReporter({ outputPath: config.outputPath })
  const summaries: FinalSummary[] = []

  await Promise.all(
    Array.from({ length: workerCount }, (_, index) => {
      const clientCount = Math.min(
        perWorker,
        config.clients - index * perWorker,
      )
      return new Promise<void>((resolve, reject) => {
        const workerConfig: LoadHarnessConfig = Object.freeze({
          ...config,
          clients: clientCount,
          outputPath: undefined,
        })
        const worker = new Worker(
          new URL('./clusterWorker.ts', import.meta.url),
          {
            execArgv: process.execArgv,
            workerData: { workerId: index + 1, config: workerConfig },
          },
        )

        worker.on('message', (message: any) => {
          if (message?.event) {
            const event = message.event as ReporterEvent
            if (event.type === 'anomaly') reporter.anomaly(event.payload)
            if (event.type === 'snapshot') reporter.snapshot(event.payload)
            return
          }
          if (message?.done && message.summary) {
            summaries.push(message.summary as FinalSummary)
            resolve()
            return
          }
          if (message?.error) {
            reject(new Error(String(message.error)))
          }
        })

        worker.on('error', reject)
        worker.on('exit', (code) => {
          if (code !== 0 && summaries.length < workerCount) {
            reject(new Error(`worker ${index + 1} exited with ${code}`))
          }
        })
      })
    }),
  )

  const summary = mergeSummaries(scenario, config, summaries)
  await reporter.summary(summary)
  return summary
}

function maxDefined(values: Array<number | undefined>): number | undefined {
  return values.reduce<number | undefined>((max, value) => {
    if (value == null) return max
    return max == null ? value : Math.max(max, value)
  }, undefined)
}

function firstDefined(values: Array<number | undefined>): number | undefined {
  return values.find((value) => value != null)
}

function lastDefined(values: Array<number | undefined>): number | undefined {
  for (let index = values.length - 1; index >= 0; index--) {
    if (values[index] != null) return values[index]
  }
  return undefined
}
