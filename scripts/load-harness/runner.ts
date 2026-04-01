import { monitorEventLoopDelay } from 'perf_hooks'
import { JsonReporter } from './reporter.js'
import { RaceResultOracle } from './oracle.js'
import { SimulatedRaceClient } from './clientSimulator.js'
import { evaluateOperationalVerdict } from './evaluation.js'
import type {
  FinalSummary,
  HarnessAnomaly,
  LoadHarnessConfig,
  ReporterEvent,
  ServerMetricsSnapshot,
  SnapshotReport,
} from './types.js'

type RunnerOptions = Readonly<{
  reporter?: JsonReporter
  emit?: (event: ReporterEvent) => void
}>

type RaceAggregate = {
  clientsFinished: number
  resultsValidated: number
  mismatches: number
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function average(total: number, count: number): number {
  return count === 0 ? 0 : total / count
}

export async function runLoadHarness(
  config: LoadHarnessConfig,
  options: RunnerOptions = {},
): Promise<FinalSummary> {
  const reporter =
    options.reporter ??
    new JsonReporter({ outputPath: config.outputPath, emit: options.emit })
  const oracle = new RaceResultOracle(config.apiBaseUrl)
  const eventLoopMonitor = monitorEventLoopDelay({ resolution: 20 })
  eventLoopMonitor.enable()

  const clients: SimulatedRaceClient[] = []
  const anomalySamples: HarnessAnomaly[] = []
  const anomalyCounts = new Map<string, number>()
  const raceAggregates = new Map<string, RaceAggregate>()
  const pendingRaceValidations = new Map<string, Promise<void>>()
  const startedAt = Date.now()
  const startedMemory = process.memoryUsage()
  let latestServerMetrics: ServerMetricsSnapshot | undefined
  let connectedPeak = 0
  let lastSnapshotFrames = 0
  let lastSnapshotAt = startedAt
  let lastCpuUsage = process.cpuUsage()
  const snapshotHistory: SnapshotReport[] = []

  const recordAnomaly = (anomaly: HarnessAnomaly) => {
    anomalyCounts.set(anomaly.type, (anomalyCounts.get(anomaly.type) ?? 0) + 1)
    if (anomalySamples.length < config.anomalySampleLimit) {
      anomalySamples.push(anomaly)
      reporter.anomaly(anomaly)
    }
  }

  const handleRaceFinish = (event: {
    clientId: string
    raceId: string
    winnerId: string
    finishOrder: ReadonlyArray<string>
  }) => {
    const aggregate = raceAggregates.get(event.raceId) ?? {
      clientsFinished: 0,
      resultsValidated: 0,
      mismatches: 0,
    }
    aggregate.clientsFinished++
    raceAggregates.set(event.raceId, aggregate)

    if (!pendingRaceValidations.has(`${event.raceId}:${event.clientId}`)) {
      const task = (async () => {
        try {
          const result = await oracle.getRaceResult(event.raceId)
          aggregate.resultsValidated++
          if (
            result.winnerId !== event.winnerId ||
            result.finishOrder.join(',') !== event.finishOrder.join(',')
          ) {
            aggregate.mismatches++
            recordAnomaly({
              timestamp: new Date().toISOString(),
              type: 'result-mismatch',
              clientId: event.clientId,
              raceId: event.raceId,
              detail: {
                observedWinnerId: event.winnerId,
                expectedWinnerId: result.winnerId,
                observedFinishOrder: event.finishOrder,
                expectedFinishOrder: result.finishOrder,
              },
            })
          }
        } catch (error) {
          recordAnomaly({
            timestamp: new Date().toISOString(),
            type: 'api-error',
            clientId: event.clientId,
            raceId: event.raceId,
            detail: {
              stage: 'result-validation',
              message: error instanceof Error ? error.message : String(error),
            },
          })
        }
      })()
      pendingRaceValidations.set(`${event.raceId}:${event.clientId}`, task)
    }
  }

  for (let index = 0; index < config.clients; index++) {
    const client = new SimulatedRaceClient(`client-${index + 1}`, config, {
      onAnomaly: recordAnomaly,
      onRaceFinish: handleRaceFinish,
    })
    clients.push(client)
  }

  const connectTasks = clients.map((client, index) =>
    (async () => {
      await sleep(index * config.joinStaggerMs)
      await client.connect()
    })(),
  )

  const metricsTimer = setInterval(async () => {
    try {
      latestServerMetrics = await oracle.getServerMetrics()
    } catch (error) {
      recordAnomaly({
        timestamp: new Date().toISOString(),
        type: 'api-error',
        clientId: 'system',
        detail: {
          stage: 'metrics-poll',
          message: error instanceof Error ? error.message : String(error),
        },
      })
    }
  }, config.metricsPollIntervalMs)

  const snapshotTimer = setInterval(() => {
    const snapshot = buildSnapshot(
      config,
      clients,
      latestServerMetrics,
      eventLoopMonitor,
      lastSnapshotFrames,
      lastSnapshotAt,
      lastCpuUsage,
      raceAggregates,
    )
    connectedPeak = Math.max(connectedPeak, snapshot.connectedClients)
    lastSnapshotFrames = snapshot.totalFrames
    lastSnapshotAt = Date.now()
    lastCpuUsage = process.cpuUsage()
    snapshotHistory.push(snapshot)
    reporter.snapshot(snapshot)
  }, config.reportIntervalMs)

  let randomDisconnectTimer: NodeJS.Timeout | null = null
  if (config.randomDisconnectPercent > 0) {
    randomDisconnectTimer = setInterval(() => {
      const connected = clients.filter(
        (client) => client.getSnapshot().connected,
      )
      const count = Math.max(
        1,
        Math.floor(connected.length * config.randomDisconnectPercent),
      )
      for (const client of connected.slice(0, count)) {
        client.disconnectAndReconnect()
      }
    }, config.randomDisconnectIntervalMs)
  }

  let stormTimer: NodeJS.Timeout | null = null
  if (config.scenario === 'reconnect-storm') {
    stormTimer = setTimeout(() => {
      const connected = clients.filter(
        (client) => client.getSnapshot().connected,
      )
      const count = Math.max(
        1,
        Math.floor(connected.length * config.stormDisconnectPercent),
      )
      for (const client of connected.slice(0, count)) {
        client.disconnectAndReconnect(
          Math.floor(Math.random() * config.stormReconnectWindowMs),
        )
      }
    }, config.stormTriggerDelayMs)
  }

  await Promise.all(connectTasks)
  await sleep(config.runDurationMs)

  clearInterval(metricsTimer)
  clearInterval(snapshotTimer)
  if (randomDisconnectTimer) clearInterval(randomDisconnectTimer)
  if (stormTimer) clearTimeout(stormTimer)

  try {
    latestServerMetrics = await oracle.getServerMetrics()
  } catch (error) {
    recordAnomaly({
      timestamp: new Date().toISOString(),
      type: 'api-error',
      clientId: 'system',
      detail: {
        stage: 'metrics-final-poll',
        message: error instanceof Error ? error.message : String(error),
      },
    })
  }

  await Promise.allSettled(Array.from(pendingRaceValidations.values()))
  for (const client of clients) {
    client.stop()
  }
  eventLoopMonitor.disable()

  const finalSnapshots = clients.map((client) => client.getSnapshot())
  const finishedAt = Date.now()
  const durationMs = finishedAt - startedAt
  const summary = buildFinalSummary(
    config,
    durationMs,
    startedAt,
    finishedAt,
    connectedPeak,
    startedMemory,
    process.memoryUsage(),
    anomalyCounts,
    raceAggregates,
    latestServerMetrics,
    snapshotHistory,
    clients,
  )
  await reporter.summary(summary)
  return summary
}

function buildSnapshot(
  config: LoadHarnessConfig,
  clients: SimulatedRaceClient[],
  latestServerMetrics: ServerMetricsSnapshot | undefined,
  eventLoopMonitor: ReturnType<typeof monitorEventLoopDelay>,
  lastFrames: number,
  lastSnapshotAt: number,
  lastCpuUsage: NodeJS.CpuUsage,
  raceAggregates: Map<string, RaceAggregate>,
): SnapshotReport {
  const now = Date.now()
  const snapshots = clients.map((client) => client.getSnapshot())
  const elapsedMs = Math.max(1, now - lastSnapshotAt)
  const totalFrames = snapshots.reduce((sum, client) => sum + client.frames, 0)
  const connectedClients = snapshots.filter((client) => client.connected).length
  const reconnectingClients = snapshots.filter(
    (client) => client.reconnecting,
  ).length
  const latencyTotal = snapshots.reduce(
    (sum, client) => sum + client.latencyAvgMs * client.frames,
    0,
  )
  const latencyFrames = snapshots.reduce(
    (sum, client) => sum + client.frames,
    0,
  )
  const maxLatencyMs = snapshots.reduce(
    (max, client) => Math.max(max, client.latencyMaxMs),
    0,
  )
  const seqGaps = snapshots.reduce((sum, client) => sum + client.seqGaps, 0)
  const seqGapFrames = snapshots.reduce(
    (sum, client) => sum + client.seqGapFrames,
    0,
  )
  const droppedFrames = snapshots.reduce(
    (sum, client) => sum + client.droppedFrames,
    0,
  )
  const reconnectAttempts = snapshots.reduce(
    (sum, client) => sum + client.reconnectAttempts,
    0,
  )
  const reconnectSuccesses = snapshots.reduce(
    (sum, client) => sum + client.reconnectSuccesses,
    0,
  )
  const syncCount = snapshots.reduce((sum, client) => sum + client.syncCount, 0)
  const syncLatencyWeighted = snapshots.reduce(
    (sum, client) => sum + client.syncLatencyAvgMs * client.syncCount,
    0,
  )
  const latencySamples = clients.flatMap((client) => [
    ...client.getLatencySamples(),
  ])
  const syncLatencySamples = clients.flatMap((client) => [
    ...client.getSyncLatencySamples(),
  ])
  const cpuUsage = process.cpuUsage(lastCpuUsage)
  return Object.freeze({
    timestamp: new Date(now).toISOString(),
    scenario: config.scenario,
    clientsConfigured: config.clients,
    connectedClients,
    reconnectingClients,
    totalFrames,
    messagesPerSecond: ((totalFrames - lastFrames) / elapsedMs) * 1000,
    avgLatencyMs: average(latencyTotal, latencyFrames),
    p95LatencyMs: percentile(latencySamples, 0.95),
    maxLatencyMs,
    seqGaps,
    seqGapFrames,
    droppedFrames,
    reconnectAttempts,
    reconnectSuccesses,
    reconnectSuccessRate: average(reconnectSuccesses, reconnectAttempts),
    syncCount,
    syncLatencyAvgMs: average(syncLatencyWeighted, syncCount),
    syncLatencyP95Ms: percentile(syncLatencySamples, 0.95),
    racesFinished: Array.from(raceAggregates.values()).reduce(
      (sum, race) => sum + race.clientsFinished,
      0,
    ),
    memoryRssMb: process.memoryUsage().rss / (1024 * 1024),
    heapUsedMb: process.memoryUsage().heapUsed / (1024 * 1024),
    cpuUserMs: cpuUsage.user / 1000,
    cpuSystemMs: cpuUsage.system / 1000,
    eventLoopLagMeanMs: Number(eventLoopMonitor.mean) / 1_000_000,
    eventLoopLagP95Ms: Number(eventLoopMonitor.percentile(95)) / 1_000_000,
    eventLoopLagMaxMs: Number(eventLoopMonitor.max) / 1_000_000,
    server: latestServerMetrics,
  })
}

function buildFinalSummary(
  config: LoadHarnessConfig,
  durationMs: number,
  startedAt: number,
  finishedAt: number,
  connectedPeak: number,
  startedMemory: NodeJS.MemoryUsage,
  finishedMemory: NodeJS.MemoryUsage,
  anomalyCounts: Map<string, number>,
  raceAggregates: Map<string, RaceAggregate>,
  latestServerMetrics: ServerMetricsSnapshot | undefined,
  snapshotHistory: SnapshotReport[],
  clients: SimulatedRaceClient[],
): FinalSummary {
  const snapshots = clients.map((client) => client.getSnapshot())
  const framesTotal = snapshots.reduce((sum, client) => sum + client.frames, 0)
  const latencyWeighted = snapshots.reduce(
    (sum, client) => sum + client.latencyAvgMs * client.frames,
    0,
  )
  const reconnectAttempts = snapshots.reduce(
    (sum, client) => sum + client.reconnectAttempts,
    0,
  )
  const reconnectSuccesses = snapshots.reduce(
    (sum, client) => sum + client.reconnectSuccesses,
    0,
  )
  const syncCount = snapshots.reduce((sum, client) => sum + client.syncCount, 0)
  const syncLatencyWeighted = snapshots.reduce(
    (sum, client) => sum + client.syncLatencyAvgMs * client.syncCount,
    0,
  )
  const latencySamples = clients.flatMap((client) => [
    ...client.getLatencySamples(),
  ])
  const syncLatencySamples = clients.flatMap((client) => [
    ...client.getSyncLatencySamples(),
  ])
  const anomalyEntries = Object.fromEntries(anomalyCounts.entries())
  const anomalyCount = Array.from(anomalyCounts.values()).reduce(
    (sum, count) => sum + count,
    0,
  )
  const worstClients = [...snapshots]
    .sort((left, right) => {
      if (right.seqGaps !== left.seqGaps) return right.seqGaps - left.seqGaps
      if (right.droppedFrames !== left.droppedFrames) {
        return right.droppedFrames - left.droppedFrames
      }
      return right.latencyMaxMs - left.latencyMaxMs
    })
    .slice(0, config.summaryTopClientCount)
    .map((client) => ({
      clientId: client.clientId,
      latencyAvgMs: client.latencyAvgMs,
      latencyP95Ms: client.latencyP95Ms,
      latencyMaxMs: client.latencyMaxMs,
      frames: client.frames,
      seqGaps: client.seqGaps,
      seqGapFrames: client.seqGapFrames,
      droppedFrames: client.droppedFrames,
      reconnectAttempts: client.reconnectAttempts,
      reconnectSuccesses: client.reconnectSuccesses,
      syncCount: client.syncCount,
      syncLatencyAvgMs: client.syncLatencyAvgMs,
      syncLatencyP95Ms: client.syncLatencyP95Ms,
      lastRaceId: client.lastRaceId,
      lastSeq: client.lastSeq,
    }))

  const perRace = Array.from(raceAggregates.entries()).map(
    ([raceId, race]) => ({
      raceId,
      clientsFinished: race.clientsFinished,
      resultsValidated: race.resultsValidated,
      mismatches: race.mismatches,
    }),
  )

  const eventLoopMeanSamples = snapshotHistory.map(
    (snapshot) => snapshot.eventLoopLagMeanMs,
  )
  const eventLoopP95Samples = snapshotHistory.map(
    (snapshot) => snapshot.eventLoopLagP95Ms,
  )
  const eventLoopMax = snapshotHistory.reduce(
    (max, snapshot) => Math.max(max, snapshot.eventLoopLagMaxMs),
    0,
  )
  const serverMemoryStart = snapshotHistory.find(
    (snapshot) => snapshot.server,
  )?.server
  const serverMemoryEnd = [...snapshotHistory]
    .reverse()
    .find((snapshot) => snapshot.server)?.server
  const baseSummary = Object.freeze({
    scenario: config.scenario,
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date(finishedAt).toISOString(),
    durationMs,
    totalClients: config.clients,
    transportMode: config.transportMode,
    binary: config.binary,
    connectedPeak,
    framesTotal,
    messagesPerSecondAvg:
      durationMs <= 0 ? 0 : (framesTotal / durationMs) * 1000,
    averageLatencyMs: average(latencyWeighted, framesTotal),
    p95LatencyMs: percentile(latencySamples, 0.95),
    worstLatencyMs: snapshots.reduce(
      (max, client) => Math.max(max, client.latencyMaxMs),
      0,
    ),
    droppedFrames: snapshots.reduce(
      (sum, client) => sum + client.droppedFrames,
      0,
    ),
    seqGaps: snapshots.reduce((sum, client) => sum + client.seqGaps, 0),
    seqGapFrames: snapshots.reduce(
      (sum, client) => sum + client.seqGapFrames,
      0,
    ),
    seqRegressions: clients.reduce(
      (sum, client) => sum + client.getSeqRegressions(),
      0,
    ),
    reconnectAttempts,
    reconnectSuccesses,
    reconnectSuccessRate: average(reconnectSuccesses, reconnectAttempts),
    syncCount,
    syncLatencyAvgMs: average(syncLatencyWeighted, syncCount),
    syncLatencyP95Ms: percentile(syncLatencySamples, 0.95),
    racesFinished: perRace.reduce((sum, race) => sum + race.clientsFinished, 0),
    resultsValidated: perRace.reduce(
      (sum, race) => sum + race.resultsValidated,
      0,
    ),
    resultMismatches: perRace.reduce((sum, race) => sum + race.mismatches, 0),
    anomalyCount,
    anomaliesByType: Object.freeze(anomalyEntries),
    eventLoopLagMeanMs: average(
      eventLoopMeanSamples.reduce((sum, value) => sum + value, 0),
      eventLoopMeanSamples.length,
    ),
    eventLoopLagP95Ms: percentile(eventLoopP95Samples, 0.95),
    eventLoopLagMaxMs: eventLoopMax,
    harnessMemoryGrowthMb:
      (finishedMemory.rss - startedMemory.rss) / (1024 * 1024),
    harnessMemoryGrowthPercent:
      startedMemory.rss <= 0
        ? 0
        : (finishedMemory.rss - startedMemory.rss) / startedMemory.rss,
    serverResidentMemoryStartMb: serverMemoryStart?.processResidentMemoryMb,
    serverResidentMemoryEndMb: serverMemoryEnd?.processResidentMemoryMb,
    serverResidentMemoryGrowthMb:
      serverMemoryStart && serverMemoryEnd
        ? serverMemoryEnd.processResidentMemoryMb -
          serverMemoryStart.processResidentMemoryMb
        : undefined,
    serverResidentMemoryGrowthPercent:
      serverMemoryStart &&
      serverMemoryEnd &&
      serverMemoryStart.processResidentMemoryMb > 0
        ? (serverMemoryEnd.processResidentMemoryMb -
            serverMemoryStart.processResidentMemoryMb) /
          serverMemoryStart.processResidentMemoryMb
        : undefined,
    maxServerTickCpuAvgMs: maxServerMetric(
      snapshotHistory,
      (server) => server.tickCpuAvgMs,
    ),
    maxServerCatchupP95Ms: maxServerMetric(
      snapshotHistory,
      (server) => server.catchupServiceP95Ms,
    ),
    maxServerFanoutP95Ms: maxServerMetric(
      snapshotHistory,
      (server) => server.fanoutP95Ms,
    ),
    verdict: 'PASS' as const,
    thresholdResults: Object.freeze([]),
    topIssues: Object.freeze([]),
    firstFailedMetric: undefined,
    investigateNext: undefined,
    perRace: Object.freeze(perRace),
    worstClients: Object.freeze(worstClients),
    latestServerMetrics,
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

function percentile(values: readonly number[], ratio: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * ratio) - 1),
  )
  return sorted[index] ?? 0
}

function maxServerMetric(
  snapshots: readonly SnapshotReport[],
  selector: (server: ServerMetricsSnapshot) => number,
): number | undefined {
  let max: number | undefined
  for (const snapshot of snapshots) {
    if (!snapshot.server) continue
    const value = selector(snapshot.server)
    max = max == null ? value : Math.max(max, value)
  }
  return max
}
