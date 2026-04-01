export type ScenarioMode = 'baseline' | 'reconnect-storm' | 'soak'

export type TransportMode = 'plain' | 'delta'

export type Verdict = 'PASS' | 'WARN' | 'FAIL'

export type AnomalyType =
  | 'seq-gap'
  | 'seq-regression'
  | 'decode-error'
  | 'delta-mismatch'
  | 'result-mismatch'
  | 'sync-timeout'
  | 'unexpected-close'
  | 'api-error'

export type RaceResultRecord = Readonly<{
  winnerId: string
  finishOrder: ReadonlyArray<string>
}>

export type LoadHarnessConfig = Readonly<{
  scenario: ScenarioMode
  wsUrl: string
  apiBaseUrl: string
  clients: number
  joinStaggerMs: number
  runDurationMs: number
  reportIntervalMs: number
  metricsPollIntervalMs: number
  transportMode: TransportMode
  binary: boolean
  token?: string
  enableCatchup: boolean
  initialSyncOnInfo: boolean
  reconnectMinDelayMs: number
  reconnectMaxDelayMs: number
  reconnectSyncTimeoutMs: number
  messageDelayMs: number
  messageDropChance: number
  slowClientPercent: number
  slowClientPauseMs: number
  randomDisconnectPercent: number
  randomDisconnectIntervalMs: number
  stormDisconnectPercent: number
  stormTriggerDelayMs: number
  stormReconnectWindowMs: number
  anomalySampleLimit: number
  summaryTopClientCount: number
  outputPath?: string
}>

export type ClientSnapshot = Readonly<{
  clientId: string
  connected: boolean
  reconnecting: boolean
  latencyAvgMs: number
  latencyP95Ms: number
  latencyMaxMs: number
  frames: number
  seqGaps: number
  seqGapFrames: number
  droppedFrames: number
  reconnectAttempts: number
  reconnectSuccesses: number
  syncCount: number
  syncLatencyAvgMs: number
  syncLatencyP95Ms: number
  lastRaceId: string | null
  lastSeq: number | null
}>

export type HarnessAnomaly = Readonly<{
  timestamp: string
  type: AnomalyType
  clientId: string
  raceId?: string
  detail: Readonly<Record<string, unknown>>
}>

export type ServerMetricsSnapshot = Readonly<{
  tickRate: number
  tickCpuAvgMs: number
  tickWallAvgMs: number
  tickDriftAvgMs: number
  tickDriftP95Ms: number
  wsClientCount: number
  wsDroppedTickFrames: number
  wsAvgBufferedAmount: number
  syncRequests: number
  syncRateLimited: number
  syncErrors: number
  catchupTicksServed: number
  catchupServiceAvgMs: number
  catchupServiceP95Ms: number
  fanoutAvgMs: number
  fanoutP95Ms: number
  busPublishSuccess: number
  busPublishErrors: number
  busPublishLatencyAvgMs: number
  busPublishLatencyP95Ms: number
  edgeRebroadcasts: number
  edgeInputLagAvgMs: number
  edgeInputLagP95Ms: number
  gcTotalCount: number
  gcTotalDurationMs: number
  processResidentMemoryMb: number
  processHeapUsedMb: number
  processCpuUserSeconds: number
  processCpuSystemSeconds: number
}>

export type SnapshotReport = Readonly<{
  timestamp: string
  scenario: ScenarioMode
  clientsConfigured: number
  connectedClients: number
  reconnectingClients: number
  totalFrames: number
  messagesPerSecond: number
  avgLatencyMs: number
  p95LatencyMs: number
  maxLatencyMs: number
  seqGaps: number
  seqGapFrames: number
  droppedFrames: number
  reconnectAttempts: number
  reconnectSuccesses: number
  reconnectSuccessRate: number
  syncCount: number
  syncLatencyAvgMs: number
  syncLatencyP95Ms: number
  racesFinished: number
  memoryRssMb: number
  heapUsedMb: number
  cpuUserMs: number
  cpuSystemMs: number
  eventLoopLagMeanMs: number
  eventLoopLagP95Ms: number
  eventLoopLagMaxMs: number
  server?: ServerMetricsSnapshot
}>

export type ClientSummary = Readonly<{
  clientId: string
  latencyAvgMs: number
  latencyP95Ms: number
  latencyMaxMs: number
  frames: number
  seqGaps: number
  seqGapFrames: number
  droppedFrames: number
  reconnectAttempts: number
  reconnectSuccesses: number
  syncCount: number
  syncLatencyAvgMs: number
  syncLatencyP95Ms: number
  lastRaceId: string | null
  lastSeq: number | null
}>

export type ThresholdAssessment = Readonly<{
  metric: string
  label: string
  verdict: Verdict
  actual: number | null
  unit?: string
  passTarget?: string
  warnTarget?: string
  note?: string
}>

export type FinalSummary = Readonly<{
  scenario: ScenarioMode
  startedAt: string
  finishedAt: string
  durationMs: number
  totalClients: number
  transportMode: TransportMode
  binary: boolean
  connectedPeak: number
  framesTotal: number
  messagesPerSecondAvg: number
  averageLatencyMs: number
  p95LatencyMs: number
  worstLatencyMs: number
  droppedFrames: number
  seqGaps: number
  seqGapFrames: number
  seqRegressions: number
  reconnectAttempts: number
  reconnectSuccesses: number
  reconnectSuccessRate: number
  syncCount: number
  syncLatencyAvgMs: number
  syncLatencyP95Ms: number
  racesFinished: number
  resultsValidated: number
  resultMismatches: number
  anomalyCount: number
  anomaliesByType: Readonly<Record<string, number>>
  eventLoopLagMeanMs: number
  eventLoopLagP95Ms: number
  eventLoopLagMaxMs: number
  harnessMemoryGrowthMb: number
  harnessMemoryGrowthPercent: number
  serverResidentMemoryStartMb?: number
  serverResidentMemoryEndMb?: number
  serverResidentMemoryGrowthMb?: number
  serverResidentMemoryGrowthPercent?: number
  maxServerTickCpuAvgMs?: number
  maxServerCatchupP95Ms?: number
  maxServerFanoutP95Ms?: number
  verdict: Verdict
  thresholdResults: ReadonlyArray<ThresholdAssessment>
  topIssues: ReadonlyArray<string>
  firstFailedMetric?: string
  investigateNext?: string
  perRace: ReadonlyArray<{
    raceId: string
    clientsFinished: number
    resultsValidated: number
    mismatches: number
  }>
  worstClients: ReadonlyArray<ClientSummary>
  latestServerMetrics?: ServerMetricsSnapshot
}>

export type RunComparison = Readonly<{
  baselinePath: string
  candidatePath: string
  baselineVerdict: Verdict
  candidateVerdict: Verdict
  verdictChanged: boolean
  improved: ReadonlyArray<string>
  worsened: ReadonlyArray<string>
  unchanged: ReadonlyArray<string>
  reconnectChanged: Readonly<Record<string, number>>
  latencyChanged: Readonly<Record<string, number>>
  anomalyChanged: Readonly<Record<string, number>>
}>

export type ReporterEvent =
  | Readonly<{ type: 'snapshot'; payload: SnapshotReport }>
  | Readonly<{ type: 'anomaly'; payload: HarnessAnomaly }>
  | Readonly<{ type: 'summary'; payload: FinalSummary }>
