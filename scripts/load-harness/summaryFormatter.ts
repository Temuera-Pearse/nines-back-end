import type { FinalSummary, ThresholdAssessment } from './types.js'

export function formatHumanSummary(
  summary: FinalSummary,
  outputPath?: string,
): string {
  const lines = [
    `Load harness verdict: ${summary.verdict}`,
    `Scenario: ${summary.scenario} | clients=${summary.totalClients} | duration=${formatDuration(summary.durationMs)}`,
    `Latency: avg=${summary.averageLatencyMs.toFixed(1)}ms p95=${summary.p95LatencyMs.toFixed(1)}ms max=${summary.worstLatencyMs.toFixed(1)}ms`,
    `Reconnects: ${summary.reconnectSuccesses}/${summary.reconnectAttempts} successful | sync avg=${summary.syncLatencyAvgMs.toFixed(1)}ms p95=${summary.syncLatencyP95Ms.toFixed(1)}ms`,
    `Sequencing: gaps=${summary.seqGaps} missingFrames=${summary.seqGapFrames} regressions=${summary.seqRegressions}`,
    `Server: catchup p95=${formatOptional(summary.maxServerCatchupP95Ms, 'ms')} | fanout p95=${formatOptional(summary.maxServerFanoutP95Ms, 'ms')} | tick cpu max=${formatOptional(summary.maxServerTickCpuAvgMs, 'ms')}`,
    `Event loop: mean=${summary.eventLoopLagMeanMs.toFixed(1)}ms p95=${summary.eventLoopLagP95Ms.toFixed(1)}ms max=${summary.eventLoopLagMaxMs.toFixed(1)}ms`,
    `Results: validated=${summary.resultsValidated} mismatches=${summary.resultMismatches} anomalies=${summary.anomalyCount}`,
  ]

  if (summary.topIssues.length > 0) {
    lines.push('Biggest issues:')
    for (const issue of summary.topIssues) {
      lines.push(`- ${issue}`)
    }
  }

  if (summary.firstFailedMetric) {
    lines.push(`First failed metric: ${summary.firstFailedMetric}`)
  }

  if (summary.investigateNext) {
    lines.push(`Investigate next: ${summary.investigateNext}`)
  }

  const failedChecks = summary.thresholdResults.filter(
    (assessment) => assessment.verdict !== 'PASS',
  )
  if (failedChecks.length > 0) {
    lines.push('Thresholds:')
    for (const assessment of failedChecks.slice(0, 6)) {
      lines.push(`- ${formatThreshold(assessment)}`)
    }
  }

  if (outputPath) {
    lines.push(`Summary JSON: ${outputPath}`)
  }

  return lines.join('\n')
}

function formatThreshold(assessment: ThresholdAssessment): string {
  const actual =
    assessment.actual === null
      ? 'n/a'
      : `${assessment.actual.toFixed(assessment.actual >= 100 ? 0 : 1)}${assessment.unit ? ` ${assessment.unit}` : ''}`
  const targets = [assessment.passTarget, assessment.warnTarget]
    .filter(Boolean)
    .join(' | ')
  return `${assessment.verdict} ${assessment.label}: actual=${actual}${targets ? ` targets ${targets}` : ''}${assessment.note ? ` (${assessment.note})` : ''}`
}

function formatDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}m ${seconds}s`
}

function formatOptional(value: number | undefined, unit: string): string {
  if (value == null) return 'n/a'
  return `${value.toFixed(1)}${unit}`
}
