import { EventEmitter } from 'events'
import { performance, PerformanceObserver, PerformanceEntry } from 'perf_hooks'

type RollingStats = Readonly<{
  count: number
  avg: number
  max: number
}>

type MetricsSnapshot = Readonly<{
  startedAt: number | null
  tickIntervalMs: number
  ticksTotal: number
  tickRate: number // ticks/sec (rolling)
  tickWallAvgMs: number // avg wall time per tick
  tickCpuAvgMs: number // avg CPU time per tick
  tickDrift: RollingStats
  ws: Readonly<{
    clientCount: number
    droppedTickFrames: number
    avgBufferedAmount: number
    latestSeqByRace: Readonly<Record<string, number>>
  }>
  gc: Readonly<{
    minorCount: number
    majorCount: number
    incrementalCount: number
    weakCbCount: number
    totalCount: number
    totalDurationMs: number
  }>
  precompute: Readonly<{
    lastMs: number
    avgMs: number
    count: number
    phases?: Readonly<Record<string, number>>
}>

class Ring {
  private buf: number[]
  private i = 0
  private filled = 0
  constructor(private readonly capacity: number) {
    this.buf = new Array(capacity)
  }
  push(v: number): void {
    this.buf[this.i] = v
    this.i = (this.i + 1) % this.capacity
    if (this.filled < this.capacity) this.filled++
  }
  stats(): RollingStats {
    if (this.filled === 0) return { count: 0, avg: 0, max: 0 }
    let sum = 0
    let max = -Infinity
    for (let k = 0; k < this.filled; k++) {
      const v = this.buf[k]
      sum += v
      if (v > max) max = v
    }
    return {
      count: this.filled,
      avg: sum / this.filled,
      max: max === -Infinity ? 0 : max,
    }
  }
  clear(): void {
    this.i = 0
    this.filled = 0
  }
}

export class EngineMetrics {
  readonly events = new EventEmitter()
  private tickIntervalMs = 50
  private startedAt: number | null = null
  private ticksTotal = 0

  // Rolling windows (cheap)
  private wallMs = new Ring(200)
  private cpuMs = new Ring(200)
  private driftMs = new Ring(200)
  private tickTimes: number[] = [] // recent tick timestamps for tick rate (last 2s)
  private tickTimesMax = 100

  // GC tracking
  private gcMinor = 0
  private gcMajor = 0
  private gcIncremental = 0
  private gcWeakCb = 0
  private gcDurMs = 0
  private gcObs: PerformanceObserver | null = null

  // Precompute
  private preLastMs = 0
  private preSumMs = 0
  private preCount = 0
  private prePhasesLast: Record<string, number> = Object.create(null)

  // Scratch for per-tick timings
  private wallStart = 0
  private cpuStart = process.cpuUsage()

  // WS metrics
  private wsClientCount = 0
  private wsDroppedTickFrames = 0
  private wsBufferedRing = new Ring(200)
  private latestSeqByRace = new Map<string, number>()

  constructor() {
    // Optional GC observer (negligible overhead)
    try {
      this.gcObs = new PerformanceObserver((list) => {
        for (const e of list.getEntries() as PerformanceEntry[]) {
          // @ts-ignore Node exposes 'kind' and 'duration' on GC entries
          const kind = (e as any).kind as number | undefined
          const dur = e.duration || 0
          this.gcDurMs += dur
          switch (kind) {
            // kind codes: 1 minor, 2 major, 4 incremental, 8 weakcb
            case 1:
              this.gcMinor++
              break
            case 2:
              this.gcMajor++
              break
            case 4:
              this.gcIncremental++
              break
            case 8:
              this.gcWeakCb++
              break
            default:
              break
          }
        }
      })
      this.gcObs.observe({ entryTypes: ['gc'] as any })
    } catch {
      // GC metrics unsupported; ignore
    }
  }

  startRace(tickIntervalMs: number): void {
    this.resetMetrics()
    this.tickIntervalMs = tickIntervalMs
    this.startedAt = performance.now()
  }

  stopRace(): void {
    // keep snapshot for inspection; do not reset automatically
  }

  beforeTick(_tickIndex: number): void {
    this.wallStart = performance.now()
    this.cpuStart = process.cpuUsage()
  }

  afterTick(_tickIndex: number, driftMs: number | null): void {
    const wallDelta = performance.now() - this.wallStart
    const cpuDelta = process.cpuUsage(this.cpuStart)
    const cpuMs = (cpuDelta.user + cpuDelta.system) / 1000

    this.wallMs.push(wallDelta)
    this.cpuMs.push(cpuMs)
    if (typeof driftMs === 'number') this.driftMs.push(driftMs)

    // tick rate: count timestamps in the last 1000ms window
    const ts = performance.now()
    this.tickTimes.push(ts)
    if (this.tickTimes.length > this.tickTimesMax) this.tickTimes.shift()
    this.ticksTotal++

    // Optional event
    if (this.ticksTotal % 20 === 0) {
      this.events.emit('metrics:tick', this.getMetrics())
    }
  }

  recordPrecomputeMs(ms: number): void {
    this.preLastMs = ms
    this.preSumMs += ms
    this.preCount++
  }

  recordPrecomputePhase(phase: string, ms: number): void {
    // Keep only last-recorded per phase; minimal overhead
    this.prePhasesLast[phase] = ms
  }

  getMetrics(): MetricsSnapshot {
    // Tick rate over last ~1s window
    const now = performance.now()
    let recent = 0
    for (let i = this.tickTimes.length - 1; i >= 0; i--) {
      if (now - this.tickTimes[i] <= 1000) recent++
      else break
    }
    const drift = this.driftMs.stats()
    const wall = this.wallMs.stats()
    const cpu = this.cpuMs.stats()

    const snap: MetricsSnapshot = {
      startedAt: this.startedAt,
      tickIntervalMs: this.tickIntervalMs,
      ticksTotal: this.ticksTotal,
      tickRate: recent, // ticks/sec
      tickWallAvgMs: wall.avg,
      tickCpuAvgMs: cpu.avg,
      tickDrift: drift,
      ws: Object.freeze({
        clientCount: this.wsClientCount,
        droppedTickFrames: this.wsDroppedTickFrames,
        avgBufferedAmount: this.wsBufferedRing.stats().avg,
        latestSeqByRace: Object.freeze(Object.fromEntries(this.latestSeqByRace.entries())),
      }),
      gc: Object.freeze({
        minorCount: this.gcMinor,
        majorCount: this.gcMajor,
        incrementalCount: this.gcIncremental,
        weakCbCount: this.gcWeakCb,
        totalCount:
          this.gcMinor + this.gcMajor + this.gcIncremental + this.gcWeakCb,
        totalDurationMs: this.gcDurMs,
      }),
      precompute: Object.freeze({
        lastMs: this.preLastMs,
        avgMs: this.preCount ? this.preSumMs / this.preCount : 0,
        count: this.preCount,
        phases: Object.freeze(this.prePhasesLast),
      }),
    }
    return Object.freeze(snap)
  }

  resetMetrics(): void {
    this.startedAt = null
    this.ticksTotal = 0
    this.wallMs.clear()
    this.cpuMs.clear()
    this.driftMs.clear()
    this.tickTimes.length = 0
    this.gcMinor = this.gcMajor = this.gcIncremental = this.gcWeakCb = 0
    this.gcDurMs = 0
    this.preLastMs = 0
    this.preSumMs = 0
    this.preCount = 0
    this.events.emit('metrics:reset')
  }

  // WS metrics APIs
  setClientCount(n: number): void {
    this.wsClientCount = n
  }
  incDroppedTickFrames(n: number = 1): void {
    this.wsDroppedTickFrames += n
  }
  recordBufferedAmount(bytes: number): void {
    this.wsBufferedRing.push(bytes)
  }
  setLatestSeq(raceId: string, seq: number): void {
    this.latestSeqByRace.set(raceId, seq)
  }
}

export const engineMetrics = new EngineMetrics()
