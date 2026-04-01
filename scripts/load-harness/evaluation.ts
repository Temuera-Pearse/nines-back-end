import type {
  FinalSummary,
  LoadHarnessConfig,
  ThresholdAssessment,
  Verdict,
} from './types.js'

type AssessmentBuilder = Readonly<{
  metric: string
  label: string
  actual: number | null
  unit?: string
  passTarget?: string
  warnTarget?: string
  note?: string
  verdict: Verdict
}>

type OperationalVerdict = Readonly<{
  verdict: Verdict
  thresholdResults: ReadonlyArray<ThresholdAssessment>
  topIssues: ReadonlyArray<string>
  firstFailedMetric?: string
  investigateNext?: string
}>

const INVESTIGATION_GUIDE: Readonly<Record<string, string>> = {
  seq_gaps:
    'Check websocket backpressure, client delay injection, and dropped frame counters first.',
  seq_regressions:
    'Inspect tick ordering across bus rebroadcasts and any replay/catch-up merge logic.',
  reconnect_success_rate:
    'Check sync request rate limiting, reconnect window sizing, and websocket close reasons.',
  sync_latency_p95:
    'Inspect catch-up payload size, race artifact lookup latency, and sync throttling.',
  message_latency_p95:
    'Check websocket fanout time, edge rebroadcast lag, and slow-client buffering.',
  catchup_latency_p95:
    'Inspect server catch-up service timing and race state cache locality.',
  event_loop_lag_mean:
    'Check event-loop blocking work, GC pressure, and concurrent polling overhead.',
  memory_growth:
    'Inspect retained client state, anomaly buffering, and websocket object cleanup during long runs.',
  cpu_stability:
    'Inspect server tick CPU timing, fanout cost, and any synchronous serialization hot spots.',
  result_mismatches:
    'Inspect finish event generation against persisted race results and any race ID drift.',
}

export function evaluateOperationalVerdict(
  summary: FinalSummary,
  config: LoadHarnessConfig,
): OperationalVerdict {
  const degradedForLossyRun =
    config.messageDropChance > 0 || config.slowClientPercent > 0
  const assessments: ThresholdAssessment[] = []

  assessments.push(
    lowerIsBetter({
      metric: 'seq_gaps',
      label: 'Sequence gap rate',
      actual:
        summary.framesTotal <= 0
          ? 0
          : summary.seqGapFrames / Math.max(1, summary.framesTotal),
      unit: 'ratio',
      pass: degradedForLossyRun ? 0.0005 : 0,
      warn: degradedForLossyRun ? 0.005 : 0.0001,
      passTarget: degradedForLossyRun ? '<= 0.0005' : '= 0',
      warnTarget: degradedForLossyRun ? '<= 0.005' : '<= 0.0001',
      note: `${summary.seqGapFrames} missing frames across ${summary.seqGaps} gaps.`,
    }),
  )

  assessments.push(
    zeroOnly({
      metric: 'seq_regressions',
      label: 'Sequence regressions',
      actual: summary.seqRegressions,
      unit: 'count',
      note: 'Any regression means clients observed non-monotonic seq ordering.',
    }),
  )

  assessments.push(
    optionalHigherIsBetter({
      metric: 'reconnect_success_rate',
      label: 'Reconnect success rate',
      actual:
        summary.reconnectAttempts === 0 ? null : summary.reconnectSuccessRate,
      unit: 'ratio',
      pass: 0.995,
      warn: 0.98,
      passTarget: '>= 0.995',
      warnTarget: '>= 0.98',
      note:
        summary.reconnectAttempts === 0
          ? 'No reconnect attempts were executed in this run.'
          : `${summary.reconnectSuccesses}/${summary.reconnectAttempts} reconnects completed.`,
    }),
  )

  assessments.push(
    lowerIsBetter({
      metric: 'sync_latency_avg',
      label: 'Sync latency average',
      actual: summary.syncCount === 0 ? 0 : summary.syncLatencyAvgMs,
      unit: 'ms',
      pass: 750,
      warn: 1500,
      passTarget: '<= 750',
      warnTarget: '<= 1500',
      note: `${summary.syncCount} sync operations recorded.`,
    }),
  )

  assessments.push(
    lowerIsBetter({
      metric: 'sync_latency_p95',
      label: 'Sync latency p95',
      actual: summary.syncCount === 0 ? 0 : summary.syncLatencyP95Ms,
      unit: 'ms',
      pass: 1500,
      warn: 3000,
      passTarget: '<= 1500',
      warnTarget: '<= 3000',
    }),
  )

  assessments.push(
    lowerIsBetter({
      metric: 'message_latency_avg',
      label: 'Message latency average',
      actual: summary.averageLatencyMs,
      unit: 'ms',
      pass: 120,
      warn: 250,
      passTarget: '<= 120',
      warnTarget: '<= 250',
    }),
  )

  assessments.push(
    lowerIsBetter({
      metric: 'message_latency_p95',
      label: 'Message latency p95',
      actual: summary.p95LatencyMs,
      unit: 'ms',
      pass: 250,
      warn: 500,
      passTarget: '<= 250',
      warnTarget: '<= 500',
    }),
  )

  assessments.push(
    optionalLowerIsBetter({
      metric: 'catchup_latency_p95',
      label: 'Catch-up latency p95',
      actual: summary.maxServerCatchupP95Ms ?? null,
      unit: 'ms',
      pass: 150,
      warn: 400,
      passTarget: '<= 150',
      warnTarget: '<= 400',
      note:
        summary.maxServerCatchupP95Ms == null
          ? 'Server catch-up latency metric was unavailable.'
          : undefined,
    }),
  )

  assessments.push(
    lowerIsBetter({
      metric: 'event_loop_lag_mean',
      label: 'Event-loop lag mean',
      actual: summary.eventLoopLagMeanMs,
      unit: 'ms',
      pass: 20,
      warn: 50,
      passTarget: '<= 20',
      warnTarget: '<= 50',
    }),
  )

  assessments.push(
    lowerIsBetter({
      metric: 'event_loop_lag_p95',
      label: 'Event-loop lag p95',
      actual: summary.eventLoopLagP95Ms,
      unit: 'ms',
      pass: 40,
      warn: 100,
      passTarget: '<= 40',
      warnTarget: '<= 100',
    }),
  )

  if (summary.scenario === 'soak') {
    assessments.push(
      optionalLowerIsBetter({
        metric: 'memory_growth',
        label: 'Server resident memory growth',
        actual:
          summary.serverResidentMemoryGrowthMb ?? summary.harnessMemoryGrowthMb,
        unit: 'MB',
        pass: 128,
        warn: 256,
        passTarget: '<= 128',
        warnTarget: '<= 256',
        note:
          summary.serverResidentMemoryGrowthMb == null
            ? `Falling back to harness memory growth (${formatNumber(summary.harnessMemoryGrowthPercent, '%')}).`
            : `Growth percentage ${formatNumber(summary.serverResidentMemoryGrowthPercent ?? 0, '%')}.`,
      }),
    )
  }

  assessments.push(
    optionalLowerIsBetter({
      metric: 'cpu_stability',
      label: 'Server tick CPU average max',
      actual: summary.maxServerTickCpuAvgMs ?? null,
      unit: 'ms',
      pass: 8,
      warn: 15,
      passTarget: '<= 8',
      warnTarget: '<= 15',
      note:
        summary.maxServerTickCpuAvgMs == null
          ? 'Server tick CPU metric was unavailable.'
          : undefined,
    }),
  )

  assessments.push(
    zeroOnly({
      metric: 'result_mismatches',
      label: 'Finish/result mismatches',
      actual: summary.resultMismatches,
      unit: 'count',
      note: `${summary.resultsValidated} result validations executed.`,
    }),
  )

  const verdict = aggregateVerdict(assessments)
  const degraded = assessments.filter(
    (assessment) => assessment.verdict !== 'PASS',
  )
  const topIssues = degraded
    .slice(0, 3)
    .map(
      (assessment) =>
        `${assessment.verdict} ${assessment.label}: ${formatAssessmentValue(assessment)}`,
    )
  const firstFailed = degraded[0]

  return Object.freeze({
    verdict,
    thresholdResults: Object.freeze(assessments),
    topIssues: Object.freeze(topIssues),
    firstFailedMetric: firstFailed?.label,
    investigateNext: firstFailed
      ? INVESTIGATION_GUIDE[firstFailed.metric]
      : undefined,
  })
}

function aggregateVerdict(
  assessments: readonly ThresholdAssessment[],
): Verdict {
  if (assessments.some((assessment) => assessment.verdict === 'FAIL'))
    return 'FAIL'
  if (assessments.some((assessment) => assessment.verdict === 'WARN'))
    return 'WARN'
  return 'PASS'
}

function lowerIsBetter(input: {
  metric: string
  label: string
  actual: number
  pass: number
  warn: number
  unit?: string
  passTarget?: string
  warnTarget?: string
  note?: string
}): ThresholdAssessment {
  return buildAssessment({
    ...input,
    verdict:
      input.actual <= input.pass
        ? 'PASS'
        : input.actual <= input.warn
          ? 'WARN'
          : 'FAIL',
  })
}

function optionalLowerIsBetter(input: {
  metric: string
  label: string
  actual: number | null
  pass: number
  warn: number
  unit?: string
  passTarget?: string
  warnTarget?: string
  note?: string
}): ThresholdAssessment {
  if (input.actual === null) {
    return buildAssessment({
      ...input,
      verdict: 'WARN',
      actual: null,
      note: input.note ?? 'Metric unavailable.',
    })
  }
  return lowerIsBetter({ ...input, actual: input.actual })
}

function optionalHigherIsBetter(input: {
  metric: string
  label: string
  actual: number | null
  pass: number
  warn: number
  unit?: string
  passTarget?: string
  warnTarget?: string
  note?: string
}): ThresholdAssessment {
  if (input.actual === null) {
    return buildAssessment({
      ...input,
      verdict: 'PASS',
      actual: null,
      note: input.note,
    })
  }
  return buildAssessment({
    ...input,
    verdict:
      input.actual >= input.pass
        ? 'PASS'
        : input.actual >= input.warn
          ? 'WARN'
          : 'FAIL',
  })
}

function zeroOnly(input: {
  metric: string
  label: string
  actual: number
  unit?: string
  note?: string
}): ThresholdAssessment {
  return buildAssessment({
    ...input,
    passTarget: '= 0',
    warnTarget: '= 0',
    verdict: input.actual === 0 ? 'PASS' : 'FAIL',
  })
}

function buildAssessment(input: AssessmentBuilder): ThresholdAssessment {
  return Object.freeze({
    metric: input.metric,
    label: input.label,
    verdict: input.verdict,
    actual: input.actual,
    unit: input.unit,
    passTarget: input.passTarget,
    warnTarget: input.warnTarget,
    note: input.note,
  })
}

function formatAssessmentValue(assessment: ThresholdAssessment): string {
  if (assessment.actual === null) return assessment.note ?? 'n/a'
  return `${formatNumber(assessment.actual, assessment.unit)}${assessment.note ? ` (${assessment.note})` : ''}`
}

function formatNumber(value: number, unit?: string): string {
  if (unit === 'ratio' || unit === '%') {
    return `${(value * 100).toFixed(2)}${unit === '%' ? '%' : '%'}`
  }
  return `${value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2)}${unit ? ` ${unit}` : ''}`
}
