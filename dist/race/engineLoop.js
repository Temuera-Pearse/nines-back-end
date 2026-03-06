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
export const engineEvents = new EventEmitter();
let running = false;
let timerRef = null;
let tickCount = 0;
let lastTickTime = null;
let nextTickTime = null;
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
    // Always emit a tick and stream precomputed positions
    engineEvents.emit('engineTick', { tick: tickCount, timestamp: Date.now() });
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
    const delay = Math.max(0, nextTickTime - performance.now());
    timerRef = setTimeout(loop, delay);
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
