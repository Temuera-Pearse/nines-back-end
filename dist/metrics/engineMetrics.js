import { EventEmitter } from 'events';
import { performance, PerformanceObserver } from 'perf_hooks';
class Ring {
    capacity;
    buf;
    i = 0;
    filled = 0;
    constructor(capacity) {
        this.capacity = capacity;
        this.buf = new Array(capacity);
    }
    push(v) {
        this.buf[this.i] = v;
        this.i = (this.i + 1) % this.capacity;
        if (this.filled < this.capacity)
            this.filled++;
    }
    stats() {
        if (this.filled === 0)
            return { count: 0, avg: 0, max: 0 };
        let sum = 0;
        let max = -Infinity;
        for (let k = 0; k < this.filled; k++) {
            const v = this.buf[k];
            sum += v;
            if (v > max)
                max = v;
        }
        return {
            count: this.filled,
            avg: sum / this.filled,
            max: max === -Infinity ? 0 : max,
        };
    }
    clear() {
        this.i = 0;
        this.filled = 0;
    }
}
export class EngineMetrics {
    events = new EventEmitter();
    tickIntervalMs = 50;
    startedAt = null;
    ticksTotal = 0;
    // Rolling windows (cheap)
    wallMs = new Ring(200);
    cpuMs = new Ring(200);
    driftMs = new Ring(200);
    tickTimes = []; // recent tick timestamps for tick rate (last 2s)
    tickTimesMax = 100;
    // GC tracking
    gcMinor = 0;
    gcMajor = 0;
    gcIncremental = 0;
    gcWeakCb = 0;
    gcDurMs = 0;
    gcObs = null;
    // Precompute
    preLastMs = 0;
    preSumMs = 0;
    preCount = 0;
    prePhasesLast = Object.create(null);
    // Scratch for per-tick timings
    wallStart = 0;
    cpuStart = process.cpuUsage();
    // WS metrics
    wsClientCount = 0;
    wsDroppedTickFrames = 0;
    wsBufferedRing = new Ring(200);
    latestSeqByRace = new Map();
    constructor() {
        // Optional GC observer (negligible overhead)
        try {
            this.gcObs = new PerformanceObserver((list) => {
                for (const e of list.getEntries()) {
                    // @ts-ignore Node exposes 'kind' and 'duration' on GC entries
                    const kind = e.kind;
                    const dur = e.duration || 0;
                    this.gcDurMs += dur;
                    switch (kind) {
                        // kind codes: 1 minor, 2 major, 4 incremental, 8 weakcb
                        case 1:
                            this.gcMinor++;
                            break;
                        case 2:
                            this.gcMajor++;
                            break;
                        case 4:
                            this.gcIncremental++;
                            break;
                        case 8:
                            this.gcWeakCb++;
                            break;
                        default:
                            break;
                    }
                }
            });
            this.gcObs.observe({ entryTypes: ['gc'] });
        }
        catch {
            // GC metrics unsupported; ignore
        }
    }
    startRace(tickIntervalMs) {
        this.resetMetrics();
        this.tickIntervalMs = tickIntervalMs;
        this.startedAt = performance.now();
    }
    stopRace() {
        // keep snapshot for inspection; do not reset automatically
    }
    beforeTick(_tickIndex) {
        this.wallStart = performance.now();
        this.cpuStart = process.cpuUsage();
    }
    afterTick(_tickIndex, driftMs) {
        const wallDelta = performance.now() - this.wallStart;
        const cpuDelta = process.cpuUsage(this.cpuStart);
        const cpuMs = (cpuDelta.user + cpuDelta.system) / 1000;
        this.wallMs.push(wallDelta);
        this.cpuMs.push(cpuMs);
        if (typeof driftMs === 'number')
            this.driftMs.push(driftMs);
        // tick rate: count timestamps in the last 1000ms window
        const ts = performance.now();
        this.tickTimes.push(ts);
        if (this.tickTimes.length > this.tickTimesMax)
            this.tickTimes.shift();
        this.ticksTotal++;
        // Optional event
        if (this.ticksTotal % 20 === 0) {
            this.events.emit('metrics:tick', this.getMetrics());
        }
    }
    recordPrecomputeMs(ms) {
        this.preLastMs = ms;
        this.preSumMs += ms;
        this.preCount++;
    }
    recordPrecomputePhase(phase, ms) {
        // Keep only last-recorded per phase; minimal overhead
        this.prePhasesLast[phase] = ms;
    }
    getMetrics() {
        // Tick rate over last ~1s window
        const now = performance.now();
        let recent = 0;
        for (let i = this.tickTimes.length - 1; i >= 0; i--) {
            if (now - this.tickTimes[i] <= 1000)
                recent++;
            else
                break;
        }
        const drift = this.driftMs.stats();
        const wall = this.wallMs.stats();
        const cpu = this.cpuMs.stats();
        const snap = {
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
                totalCount: this.gcMinor + this.gcMajor + this.gcIncremental + this.gcWeakCb,
                totalDurationMs: this.gcDurMs,
            }),
            precompute: Object.freeze({
                lastMs: this.preLastMs,
                avgMs: this.preCount ? this.preSumMs / this.preCount : 0,
                count: this.preCount,
                phases: Object.freeze(this.prePhasesLast),
            }),
        };
        return Object.freeze(snap);
    }
    resetMetrics() {
        this.startedAt = null;
        this.ticksTotal = 0;
        this.wallMs.clear();
        this.cpuMs.clear();
        this.driftMs.clear();
        this.tickTimes.length = 0;
        this.gcMinor = this.gcMajor = this.gcIncremental = this.gcWeakCb = 0;
        this.gcDurMs = 0;
        this.preLastMs = 0;
        this.preSumMs = 0;
        this.preCount = 0;
        this.events.emit('metrics:reset');
    }
    // WS metrics APIs
    setClientCount(n) {
        this.wsClientCount = n;
    }
    incDroppedTickFrames(n = 1) {
        this.wsDroppedTickFrames += n;
    }
    recordBufferedAmount(bytes) {
        this.wsBufferedRing.push(bytes);
    }
    setLatestSeq(raceId, seq) {
        this.latestSeqByRace.set(raceId, seq);
    }
}
export const engineMetrics = new EngineMetrics();
