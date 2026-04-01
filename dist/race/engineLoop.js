import { EventEmitter } from 'events';
import { performance } from 'perf_hooks';
import { streamPrecomputedTickAt } from './raceEngine.js';
import { RaceState } from './raceState.js';
import { logEvent } from '../utils/logEvent.js';
import { engineMetrics } from '../metrics/engineMetrics.js';
// Timing constants (20Hz loop)
export const TICK_RATE = 20;
export const TICK_INTERVAL = 50;
export const DRIFT_TOLERANCE = 5;
// Wake up this many ms before the target, then spin with setImmediate for precision.
// Cost: ~PRESPIN_MS of setImmediate callbacks per tick (negligible CPU at 20Hz).
const PRESPIN_MS = 4;
export const engineEvents = new EventEmitter();
let running = false;
let timerRef = null;
let immediateRef = null;
let tickCount = 0;
let lastTickTime = null;
let nextTickTime = null;
/**
 * setImmediate spin phase: runs every event-loop turn (~0.1–0.3ms resolution)
 * until the target time is reached, then fires loop().
 * This fires in the same event-loop iteration that GC finishes — much tighter
 * than waiting for the next setTimeout slot.
 */
function spinToTarget() {
    if (!running)
        return;
    if (performance.now() < nextTickTime) {
        immediateRef = setImmediate(spinToTarget);
        return;
    }
    immediateRef = null;
    loop();
}
function loop() {
    if (!running)
        return;
    const now = performance.now();
    // Compute drift from planned nextTickTime
    if (nextTickTime === null)
        nextTickTime = now;
    const drift = now - nextTickTime;
    if (Math.abs(drift) > DRIFT_TOLERANCE) {
        logEvent('engine:drift-warn', { driftMs: Number(drift.toFixed(2)) });
    }
    // Metrics: before tick
    engineMetrics.beforeTick(tickCount);
    // Only stream when the lifecycle is actually running and the race has started.
    // This prevents noisy errors when the engine is started before a race is seeded.
    const sm = RaceState.getStateMachine();
    const pre = RaceState.getPrecomputedRace();
    if (sm.is('race_running') && pre?.startTime) {
        try {
            // Stream by authoritative tick index
            streamPrecomputedTickAt(tickCount);
        }
        catch (e) {
            logEvent('engine:stream-error', { error: e?.message ?? String(e) });
        }
    }
    // Metrics: after tick
    engineMetrics.afterTick(tickCount, drift);
    // Stop automatically once last tick is emitted
    if (pre && tickCount >= pre.ticks.length - 1) {
        stop();
        return;
    }
    // Advance schedule with self-correcting nextTickTime
    lastTickTime = now;
    nextTickTime += TICK_INTERVAL;
    tickCount += 1;
    // Early-schedule: sleep until PRESPIN_MS before target, then spin with setImmediate.
    // This gives sub-millisecond precision vs. raw setTimeout and catches the event loop
    // immediately after a GC pause ends.
    const delay = Math.max(0, nextTickTime - performance.now());
    if (delay <= PRESPIN_MS) {
        immediateRef = setImmediate(spinToTarget);
    }
    else {
        timerRef = setTimeout(() => {
            immediateRef = setImmediate(spinToTarget);
        }, delay - PRESPIN_MS);
    }
}
export function start() {
    if (running)
        return;
    running = true;
    tickCount = 0;
    lastTickTime = performance.now();
    nextTickTime = lastTickTime; // start immediately
    engineMetrics.startRace(TICK_INTERVAL);
    logEvent('engine:start', { hz: TICK_RATE, intervalMs: TICK_INTERVAL });
    timerRef = setTimeout(loop, 0);
}
export function stop() {
    if (!running)
        return;
    running = false;
    if (timerRef) {
        clearTimeout(timerRef);
        timerRef = null;
    }
    if (immediateRef) {
        clearImmediate(immediateRef);
        immediateRef = null;
    }
    engineMetrics.stopRace();
    logEvent('engine:stop', { ticksEmitted: tickCount });
}
export function reset() {
    stop();
    tickCount = 0;
    lastTickTime = null;
    nextTickTime = null;
    engineMetrics.resetMetrics();
    logEvent('engine:reset', {});
}
export function isRunning() {
    return running;
}
