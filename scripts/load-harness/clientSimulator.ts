import WebSocket from 'ws'
import type { Socket } from 'net'
import type {
  ClientSnapshot,
  HarnessAnomaly,
  LoadHarnessConfig,
} from './types.js'

const SAMPLE_LIMIT = 512

type RaceFinishEvent = Readonly<{
  clientId: string
  raceId: string
  winnerId: string
  finishOrder: ReadonlyArray<string>
}>

type ClientCallbacks = Readonly<{
  onAnomaly: (anomaly: HarnessAnomaly) => void
  onRaceFinish: (event: RaceFinishEvent) => void
}>

type SyncRequest = Readonly<{
  raceId: string
  fromTick?: number
}>

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function randomBetween(min: number, max: number): number {
  if (max <= min) return min
  return min + Math.floor(Math.random() * (max - min + 1))
}

function almostEqual(a: number, b: number, epsilon = 1e-6): boolean {
  return Math.abs(a - b) <= epsilon
}

export class SimulatedRaceClient {
  private ws: WebSocket | null = null
  private stopped = false
  private currentRaceId: string | null = null
  private lastSeq: number | null = null
  private lastTickIndex = -1
  private frames = 0
  private latencyCount = 0
  private latencyTotalMs = 0
  private latencyMaxMs = 0
  private latencySamples: number[] = []
  private latencySampleCursor = 0
  private seqGaps = 0
  private seqGapFrames = 0
  private droppedFrames = 0
  private reconnectAttempts = 0
  private reconnectSuccesses = 0
  private syncCount = 0
  private syncLatencyTotalMs = 0
  private syncLatencySamples: number[] = []
  private syncLatencySampleCursor = 0
  private pendingSyncStartedAt: number | null = null
  private awaitingReconnectFrameSince: number | null = null
  private expectedClose = false
  private plannedReconnectDelayMs: number | null = null
  private slowSocketTimer: NodeJS.Timeout | null = null
  private lastPositions: number[] | null = null
  private readonly isSlowClient: boolean
  private seqRegressions = 0

  constructor(
    readonly clientId: string,
    private readonly config: LoadHarnessConfig,
    private readonly callbacks: ClientCallbacks,
  ) {
    this.isSlowClient = Math.random() < this.config.slowClientPercent
  }

  async connect(): Promise<void> {
    if (this.stopped) return
    const url = new URL(this.config.wsUrl)
    url.searchParams.set('mode', this.config.transportMode)
    if (this.config.binary) url.searchParams.set('binary', '1')
    if (this.config.token) url.searchParams.set('token', this.config.token)

    this.ws = new WebSocket(url.toString())
    this.ws.on('open', () => {
      this.expectedClose = false
      if (this.isSlowClient && this.config.slowClientPauseMs > 0) {
        this.startSlowSocketLoop()
      }
    })
    this.ws.on('message', (data, isBinary) => {
      void this.handleIncomingMessage(data, isBinary)
    })
    this.ws.on('close', () => {
      this.stopSlowSocketLoop()
      const reconnectDelayMs = this.plannedReconnectDelayMs
      this.plannedReconnectDelayMs = null
      if (!this.stopped && !this.expectedClose) {
        this.emitAnomaly('unexpected-close', {
          reconnectPlanned: reconnectDelayMs !== null,
        })
      }
      if (!this.stopped && reconnectDelayMs !== null) {
        void this.reconnectAfter(reconnectDelayMs)
      }
    })
    this.ws.on('error', (error) => {
      if (!this.stopped) {
        this.emitAnomaly('decode-error', {
          stage: 'socket',
          message: error instanceof Error ? error.message : String(error),
        })
      }
    })
  }

  stop(): void {
    this.stopped = true
    this.stopSlowSocketLoop()
    this.expectedClose = true
    this.plannedReconnectDelayMs = null
    try {
      this.ws?.close()
    } catch {}
  }

  disconnectAndReconnect(delayMs?: number): void {
    if (this.stopped) return
    this.reconnectAttempts++
    this.awaitingReconnectFrameSince = Date.now()
    this.pendingSyncStartedAt = null
    this.expectedClose = true
    this.plannedReconnectDelayMs =
      delayMs ??
      randomBetween(
        this.config.reconnectMinDelayMs,
        this.config.reconnectMaxDelayMs,
      )
    try {
      this.ws?.terminate()
    } catch {}
  }

  getSnapshot(): ClientSnapshot {
    return Object.freeze({
      clientId: this.clientId,
      connected: this.ws?.readyState === WebSocket.OPEN,
      reconnecting: this.awaitingReconnectFrameSince !== null,
      latencyAvgMs:
        this.latencyCount === 0 ? 0 : this.latencyTotalMs / this.latencyCount,
      latencyP95Ms: percentile(this.latencySamples, 0.95),
      latencyMaxMs: this.latencyMaxMs,
      frames: this.frames,
      seqGaps: this.seqGaps,
      seqGapFrames: this.seqGapFrames,
      droppedFrames: this.droppedFrames,
      reconnectAttempts: this.reconnectAttempts,
      reconnectSuccesses: this.reconnectSuccesses,
      syncCount: this.syncCount,
      syncLatencyAvgMs:
        this.syncCount === 0 ? 0 : this.syncLatencyTotalMs / this.syncCount,
      syncLatencyP95Ms: percentile(this.syncLatencySamples, 0.95),
      lastRaceId: this.currentRaceId,
      lastSeq: this.lastSeq,
    })
  }

  getLatencySamples(): readonly number[] {
    return this.latencySamples
  }

  getSyncLatencySamples(): readonly number[] {
    return this.syncLatencySamples
  }

  getSeqRegressions(): number {
    return this.seqRegressions
  }

  private async reconnectAfter(delayMs: number): Promise<void> {
    await sleep(delayMs)
    if (this.stopped) return
    await this.connect()
  }

  private startSlowSocketLoop(): void {
    const socket = this.getUnderlyingSocket()
    if (!socket || this.slowSocketTimer) return
    const intervalMs = Math.max(500, this.config.slowClientPauseMs * 2)
    this.slowSocketTimer = setInterval(() => {
      const currentSocket = this.getUnderlyingSocket()
      if (!currentSocket) return
      currentSocket.pause()
      setTimeout(() => {
        try {
          currentSocket.resume()
        } catch {}
      }, this.config.slowClientPauseMs)
    }, intervalMs)
  }

  private stopSlowSocketLoop(): void {
    if (this.slowSocketTimer) {
      clearInterval(this.slowSocketTimer)
      this.slowSocketTimer = null
    }
  }

  private getUnderlyingSocket(): Socket | null {
    const socket = (this.ws as (WebSocket & { _socket?: Socket }) | null)
      ?._socket
    return socket ?? null
  }

  private async handleIncomingMessage(
    raw: WebSocket.RawData,
    isBinary: boolean,
  ): Promise<void> {
    if (this.stopped) return
    if (
      this.config.messageDropChance > 0 &&
      Math.random() < this.config.messageDropChance
    ) {
      this.droppedFrames++
      return
    }
    if (this.config.messageDelayMs > 0) {
      await sleep(this.config.messageDelayMs)
    }

    try {
      const message = isBinary
        ? this.parseBinaryFrame(raw)
        : JSON.parse(raw.toString())
      if (message.type === 'race:catchup') {
        const ticks = Array.isArray(message.ticks) ? message.ticks : []
        for (const tick of ticks) {
          this.processTickLikeMessage(tick, true)
        }
        return
      }
      if (message.type === 'race:sync-complete') {
        this.handleSyncComplete()
        return
      }
      if (message.type === 'race:info') {
        this.handleRaceInfo(message)
        return
      }
      if (
        message.type === 'race:tick' ||
        message.type === 'race:keyframe' ||
        message.type === 'race:delta'
      ) {
        this.processTickLikeMessage(message, false)
        return
      }
      if (message.type === 'race:finish') {
        const raceId = message.raceId ?? this.currentRaceId
        if (typeof raceId === 'string') {
          this.callbacks.onRaceFinish({
            clientId: this.clientId,
            raceId,
            winnerId: String(message.winnerId ?? ''),
            finishOrder: Object.freeze([...(message.finishOrder ?? [])]),
          })
        }
      }
    } catch (error) {
      this.emitAnomaly('decode-error', {
        stage: isBinary ? 'binary-frame' : 'json-frame',
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  private parseBinaryFrame(raw: WebSocket.RawData): any {
    const buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer)
    const delimiterIndex = buffer.indexOf(0x0a)
    if (delimiterIndex < 0) {
      throw new Error('binary frame missing header delimiter')
    }
    const header = JSON.parse(
      buffer.subarray(0, delimiterIndex).toString('utf8'),
    ) as any
    const body = buffer.subarray(delimiterIndex + 1)
    const byteOffset = body.byteOffset
    const floatLength = Math.floor(
      body.byteLength / Float32Array.BYTES_PER_ELEMENT,
    )
    const positions = Array.from(
      new Float32Array(body.buffer, byteOffset, floatLength),
    )
    return {
      ...header,
      raceId: header.raceId ?? this.currentRaceId,
      data: {
        ...(header.data ?? {}),
        positions,
      },
    }
  }

  private handleRaceInfo(message: any): void {
    const raceId = typeof message.raceId === 'string' ? message.raceId : null
    if (!raceId) return
    if (this.currentRaceId !== raceId) {
      this.currentRaceId = raceId
      this.lastSeq = null
      this.lastTickIndex = -1
      this.lastPositions = null
    }
    const currentTickIndex =
      typeof message.currentTickIndex === 'number'
        ? message.currentTickIndex
        : -1

    if (
      this.config.enableCatchup &&
      this.config.initialSyncOnInfo &&
      currentTickIndex >= 0
    ) {
      const request: SyncRequest =
        this.lastTickIndex >= 0
          ? { raceId, fromTick: this.lastTickIndex + 1 }
          : { raceId }
      this.requestSync(request)
    }
  }

  private requestSync(request: SyncRequest): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    this.pendingSyncStartedAt = Date.now()
    this.ws.send(
      JSON.stringify({
        type: 'sync:request',
        raceId: request.raceId,
        ...(typeof request.fromTick === 'number'
          ? { fromTick: request.fromTick }
          : {}),
      }),
    )

    const requestedAt = this.pendingSyncStartedAt
    setTimeout(() => {
      if (this.pendingSyncStartedAt !== requestedAt) return
      this.emitAnomaly('sync-timeout', {
        raceId: request.raceId,
        timeoutMs: this.config.reconnectSyncTimeoutMs,
      })
    }, this.config.reconnectSyncTimeoutMs)
  }

  private handleSyncComplete(): void {
    if (this.pendingSyncStartedAt === null) return
    const durationMs = Date.now() - this.pendingSyncStartedAt
    this.pendingSyncStartedAt = null
    this.syncCount++
    this.syncLatencyTotalMs += durationMs
    this.syncLatencySampleCursor = appendSample(
      this.syncLatencySamples,
      durationMs,
      SAMPLE_LIMIT,
      this.syncLatencySampleCursor,
    )
    if (this.awaitingReconnectFrameSince !== null) {
      this.reconnectSuccesses++
      this.awaitingReconnectFrameSince = null
    }
  }

  private processTickLikeMessage(message: any, fromCatchup: boolean): void {
    const raceId =
      typeof message.raceId === 'string' ? message.raceId : this.currentRaceId
    if (!raceId) return
    if (this.currentRaceId !== raceId) {
      this.currentRaceId = raceId
      this.lastSeq = null
      this.lastTickIndex = -1
      this.lastPositions = null
    }

    const seq = typeof message.seq === 'number' ? message.seq : null
    const tickIndex =
      typeof message.tickIndex === 'number'
        ? message.tickIndex
        : typeof message?.data?.tickIndex === 'number'
          ? message.data.tickIndex
          : -1
    const tickTs = typeof message.tickTs === 'number' ? message.tickTs : null

    const positions = this.extractPositions(message)
    if (positions) {
      this.lastPositions = positions
    }

    this.frames++
    if (tickTs !== null) {
      const latencyMs = Math.max(0, Date.now() - tickTs)
      this.latencyCount++
      this.latencyTotalMs += latencyMs
      this.latencyMaxMs = Math.max(this.latencyMaxMs, latencyMs)
      this.latencySampleCursor = appendSample(
        this.latencySamples,
        latencyMs,
        SAMPLE_LIMIT,
        this.latencySampleCursor,
      )
    }

    if (seq !== null && this.lastSeq !== null) {
      if (seq <= this.lastSeq) {
        this.seqRegressions++
        this.emitAnomaly('seq-regression', {
          raceId,
          prevSeq: this.lastSeq,
          nextSeq: seq,
          fromCatchup,
        })
      } else if (seq > this.lastSeq + 1) {
        const missing = seq - this.lastSeq - 1
        this.seqGaps++
        this.seqGapFrames += missing
        this.emitAnomaly('seq-gap', {
          raceId,
          prevSeq: this.lastSeq,
          nextSeq: seq,
          missing,
          fromCatchup,
        })
      }
    }

    if (seq !== null) {
      this.lastSeq = seq
    }
    if (tickIndex >= 0) {
      this.lastTickIndex = Math.max(this.lastTickIndex, tickIndex)
    }

    if (
      !fromCatchup &&
      this.awaitingReconnectFrameSince !== null &&
      this.pendingSyncStartedAt === null
    ) {
      this.reconnectSuccesses++
      this.awaitingReconnectFrameSince = null
    }
  }

  private extractPositions(message: any): number[] | null {
    const data = message?.data ?? {}
    const positions = Array.isArray(data.positions)
      ? data.positions.map((value: unknown) => Number(value))
      : null
    const deltas = Array.isArray(data.deltas)
      ? data.deltas.map((value: unknown) => Number(value))
      : null

    if (message.type === 'race:keyframe' && positions) {
      return positions
    }

    if (message.type === 'race:delta' && deltas && this.lastPositions) {
      const reconstructed = this.lastPositions.map(
        (value, index) => value + (deltas[index] ?? 0),
      )
      if (positions) {
        const mismatch = reconstructed.some(
          (value, index) => !almostEqual(value, positions[index] ?? value),
        )
        if (mismatch) {
          this.emitAnomaly('delta-mismatch', {
            raceId: this.currentRaceId ?? undefined,
            positionsLength: positions.length,
            deltasLength: deltas.length,
          })
        }
        return positions
      }
      return reconstructed
    }

    return positions
  }

  private emitAnomaly(
    type: HarnessAnomaly['type'],
    detail: Readonly<Record<string, unknown>>,
  ): void {
    this.callbacks.onAnomaly({
      timestamp: new Date().toISOString(),
      type,
      clientId: this.clientId,
      raceId:
        typeof detail.raceId === 'string'
          ? detail.raceId
          : (this.currentRaceId ?? undefined),
      detail,
    })
  }
}

function appendSample(
  samples: number[],
  value: number,
  limit: number,
  cursor: number,
): number {
  if (samples.length < limit) {
    samples.push(value)
    return cursor
  }
  samples[cursor] = value
  return (cursor + 1) % limit
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
