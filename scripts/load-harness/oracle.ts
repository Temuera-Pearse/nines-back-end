import type { RaceResultRecord, ServerMetricsSnapshot } from './types.js'

function parsePrometheusMetric(text: string, name: string): number {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = text.match(
    new RegExp(`^${escapedName}\\s+(-?\\d+(?:\\.\\d+)?)$`, 'm'),
  )
  return match ? Number(match[1]) : 0
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export class RaceResultOracle {
  private readonly resultCache = new Map<string, RaceResultRecord>()

  constructor(private readonly apiBaseUrl: string) {}

  async getRaceResult(raceId: string): Promise<RaceResultRecord> {
    const cached = this.resultCache.get(raceId)
    if (cached) return cached

    let lastError: unknown = null
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        const response = await fetch(
          `${this.apiBaseUrl}/race/results/${raceId}`,
        )
        if (!response.ok) {
          lastError = new Error(`HTTP ${response.status}`)
        } else {
          const payload = (await response.json()) as {
            winnerId?: string
            finishOrder?: string[]
            winner?: string
            placements?: string[]
          }
          const result = Object.freeze({
            winnerId: payload.winnerId ?? payload.winner ?? '',
            finishOrder: Object.freeze([
              ...(payload.finishOrder ?? payload.placements ?? []),
            ]),
          })
          if (result.winnerId && result.finishOrder.length > 0) {
            this.resultCache.set(raceId, result)
            return result
          }
          lastError = new Error('race result missing winner or finish order')
        }
      } catch (error) {
        lastError = error
      }
      await sleep(500)
    }

    throw lastError instanceof Error
      ? lastError
      : new Error(`unable to load results for ${raceId}`)
  }

  async getServerMetrics(): Promise<ServerMetricsSnapshot> {
    const [raceMetricsResponse, prometheusResponse] = await Promise.all([
      fetch(`${this.apiBaseUrl}/race/metrics`),
      fetch(`${this.apiBaseUrl}/metrics`),
    ])
    if (!raceMetricsResponse.ok) {
      throw new Error(
        `metrics request failed: HTTP ${raceMetricsResponse.status}`,
      )
    }

    const payload = (await raceMetricsResponse.json()) as any
    const prometheusText = prometheusResponse.ok
      ? await prometheusResponse.text()
      : ''
    return Object.freeze({
      tickRate: Number(payload?.tickRate ?? 0),
      tickCpuAvgMs: Number(payload?.tickCpuAvgMs ?? 0),
      tickWallAvgMs: Number(payload?.tickWallAvgMs ?? 0),
      tickDriftAvgMs: Number(payload?.tickDrift?.avg ?? 0),
      tickDriftP95Ms: Number(payload?.tickDrift?.p95 ?? 0),
      wsClientCount: Number(payload?.ws?.clientCount ?? 0),
      wsDroppedTickFrames: Number(payload?.ws?.droppedTickFrames ?? 0),
      wsAvgBufferedAmount: Number(payload?.ws?.avgBufferedAmount ?? 0),
      syncRequests: Number(payload?.ws?.sync?.requests ?? 0),
      syncRateLimited: Number(payload?.ws?.sync?.rateLimited ?? 0),
      syncErrors: Number(payload?.ws?.sync?.errors ?? 0),
      catchupTicksServed: Number(payload?.ws?.sync?.catchupTicksServed ?? 0),
      catchupServiceAvgMs: Number(
        payload?.ws?.sync?.catchupServiceMs?.avg ?? 0,
      ),
      catchupServiceP95Ms: Number(
        payload?.ws?.sync?.catchupServiceMs?.p95 ?? 0,
      ),
      fanoutAvgMs: Number(payload?.ws?.broadcast?.fanoutMs?.avg ?? 0),
      fanoutP95Ms: Number(payload?.ws?.broadcast?.fanoutMs?.p95 ?? 0),
      busPublishSuccess: Number(payload?.ws?.bus?.publishSuccess ?? 0),
      busPublishErrors: Number(payload?.ws?.bus?.publishErrors ?? 0),
      busPublishLatencyAvgMs: Number(
        payload?.ws?.bus?.publishLatencyMs?.avg ?? 0,
      ),
      busPublishLatencyP95Ms: Number(
        payload?.ws?.bus?.publishLatencyMs?.p95 ?? 0,
      ),
      edgeRebroadcasts: Number(payload?.ws?.edge?.rebroadcasts ?? 0),
      edgeInputLagAvgMs: Number(payload?.ws?.edge?.inputLagMs?.avg ?? 0),
      edgeInputLagP95Ms: Number(payload?.ws?.edge?.inputLagMs?.p95 ?? 0),
      gcTotalCount: Number(payload?.gc?.totalCount ?? 0),
      gcTotalDurationMs: Number(payload?.gc?.totalDurationMs ?? 0),
      processResidentMemoryMb:
        parsePrometheusMetric(
          prometheusText,
          'nines_process_resident_memory_bytes',
        ) /
        (1024 * 1024),
      processHeapUsedMb:
        parsePrometheusMetric(
          prometheusText,
          'nines_nodejs_heap_size_used_bytes',
        ) /
        (1024 * 1024),
      processCpuUserSeconds: parsePrometheusMetric(
        prometheusText,
        'nines_process_cpu_user_seconds_total',
      ),
      processCpuSystemSeconds: parsePrometheusMetric(
        prometheusText,
        'nines_process_cpu_system_seconds_total',
      ),
    })
  }
}
