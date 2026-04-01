import { readFile } from 'fs/promises'
import path from 'path'
import type { FinalSummary, RunComparison } from './load-harness/types.js'

async function main(): Promise<void> {
  const [baselinePathArg, candidatePathArg] = process.argv.slice(2)
  if (!baselinePathArg || !candidatePathArg) {
    console.error(
      'Usage: tsx scripts/load-compare.ts <baseline-summary.json> <candidate-summary.json>',
    )
    process.exitCode = 1
    return
  }

  const baselinePath = path.resolve(baselinePathArg)
  const candidatePath = path.resolve(candidatePathArg)
  const [baseline, candidate] = await Promise.all([
    readSummary(baselinePath),
    readSummary(candidatePath),
  ])

  const comparison = compareRuns(
    baselinePath,
    baseline,
    candidatePath,
    candidate,
  )
  process.stdout.write(`${formatComparison(comparison)}\n`)
  process.stdout.write(`${JSON.stringify(comparison, null, 2)}\n`)
}

async function readSummary(filePath: string): Promise<FinalSummary> {
  const contents = await readFile(filePath, 'utf8')
  return JSON.parse(contents) as FinalSummary
}

function compareRuns(
  baselinePath: string,
  baseline: FinalSummary,
  candidatePath: string,
  candidate: FinalSummary,
): RunComparison {
  const improved: string[] = []
  const worsened: string[] = []
  const unchanged: string[] = []

  const reconnectChanged = Object.freeze({
    baseline: baseline.reconnectSuccessRate,
    candidate: candidate.reconnectSuccessRate,
    delta: candidate.reconnectSuccessRate - baseline.reconnectSuccessRate,
  })
  const latencyChanged = Object.freeze({
    averageLatencyMs: candidate.averageLatencyMs - baseline.averageLatencyMs,
    p95LatencyMs: candidate.p95LatencyMs - baseline.p95LatencyMs,
    syncLatencyP95Ms: candidate.syncLatencyP95Ms - baseline.syncLatencyP95Ms,
    catchupLatencyP95Ms:
      (candidate.maxServerCatchupP95Ms ?? 0) -
      (baseline.maxServerCatchupP95Ms ?? 0),
  })
  const anomalyChanged = Object.freeze({
    anomalyCount: candidate.anomalyCount - baseline.anomalyCount,
    seqGapFrames: candidate.seqGapFrames - baseline.seqGapFrames,
    resultMismatches: candidate.resultMismatches - baseline.resultMismatches,
  })

  compareLower(
    'Average latency',
    baseline.averageLatencyMs,
    candidate.averageLatencyMs,
    improved,
    worsened,
    unchanged,
  )
  compareLower(
    'Latency p95',
    baseline.p95LatencyMs,
    candidate.p95LatencyMs,
    improved,
    worsened,
    unchanged,
  )
  compareHigher(
    'Reconnect success rate',
    baseline.reconnectSuccessRate,
    candidate.reconnectSuccessRate,
    improved,
    worsened,
    unchanged,
  )
  compareLower(
    'Sync latency p95',
    baseline.syncLatencyP95Ms,
    candidate.syncLatencyP95Ms,
    improved,
    worsened,
    unchanged,
  )
  compareLower(
    'Catch-up latency p95',
    baseline.maxServerCatchupP95Ms ?? 0,
    candidate.maxServerCatchupP95Ms ?? 0,
    improved,
    worsened,
    unchanged,
  )
  compareLower(
    'Event-loop lag mean',
    baseline.eventLoopLagMeanMs,
    candidate.eventLoopLagMeanMs,
    improved,
    worsened,
    unchanged,
  )
  compareLower(
    'Server memory growth',
    baseline.serverResidentMemoryGrowthMb ?? baseline.harnessMemoryGrowthMb,
    candidate.serverResidentMemoryGrowthMb ?? candidate.harnessMemoryGrowthMb,
    improved,
    worsened,
    unchanged,
  )
  compareLower(
    'Seq gap frames',
    baseline.seqGapFrames,
    candidate.seqGapFrames,
    improved,
    worsened,
    unchanged,
  )
  compareLower(
    'Result mismatches',
    baseline.resultMismatches,
    candidate.resultMismatches,
    improved,
    worsened,
    unchanged,
  )

  return Object.freeze({
    baselinePath,
    candidatePath,
    baselineVerdict: baseline.verdict,
    candidateVerdict: candidate.verdict,
    verdictChanged: baseline.verdict !== candidate.verdict,
    improved: Object.freeze(improved),
    worsened: Object.freeze(worsened),
    unchanged: Object.freeze(unchanged),
    reconnectChanged,
    latencyChanged,
    anomalyChanged,
  })
}

function compareLower(
  label: string,
  baseline: number,
  candidate: number,
  improved: string[],
  worsened: string[],
  unchanged: string[],
): void {
  if (candidate < baseline) {
    improved.push(`${label}: ${candidate.toFixed(2)} vs ${baseline.toFixed(2)}`)
    return
  }
  if (candidate > baseline) {
    worsened.push(`${label}: ${candidate.toFixed(2)} vs ${baseline.toFixed(2)}`)
    return
  }
  unchanged.push(`${label}: unchanged at ${candidate.toFixed(2)}`)
}

function compareHigher(
  label: string,
  baseline: number,
  candidate: number,
  improved: string[],
  worsened: string[],
  unchanged: string[],
): void {
  if (candidate > baseline) {
    improved.push(`${label}: ${candidate.toFixed(4)} vs ${baseline.toFixed(4)}`)
    return
  }
  if (candidate < baseline) {
    worsened.push(`${label}: ${candidate.toFixed(4)} vs ${baseline.toFixed(4)}`)
    return
  }
  unchanged.push(`${label}: unchanged at ${candidate.toFixed(4)}`)
}

function formatComparison(comparison: RunComparison): string {
  const lines = [
    `Baseline: ${comparison.baselinePath}`,
    `Candidate: ${comparison.candidatePath}`,
    `Verdicts: ${comparison.baselineVerdict} -> ${comparison.candidateVerdict}`,
  ]

  if (comparison.improved.length > 0) {
    lines.push('Improved:')
    for (const item of comparison.improved) lines.push(`- ${item}`)
  }
  if (comparison.worsened.length > 0) {
    lines.push('Worsened:')
    for (const item of comparison.worsened) lines.push(`- ${item}`)
  }
  if (comparison.unchanged.length > 0) {
    lines.push('Unchanged:')
    for (const item of comparison.unchanged.slice(0, 4)) lines.push(`- ${item}`)
  }

  return lines.join('\n')
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
