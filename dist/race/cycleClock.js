import { MasterTimeline } from '../timeline/masterTimeline.js';
import { RaceState } from './raceState.js';
import { isRunning, start as startEngine, stop as stopEngine, } from './engineLoop.js';
import { getLeaderRole } from '../leader/elector.js';
import { logEvent } from '../utils/logEvent.js';
let running = false;
let unsubscribe = null;
const CLOCK_ID = 'cycleClock:main';
const INTERVAL_MS = 1000;
function shouldDriveLifecycle() {
    // If leader election is enabled, only the leader drives lifecycle.
    if (process.env.LEADER_ELECTION === '1')
        return getLeaderRole() === 'leader';
    // Otherwise default to a single-instance "leader".
    return (process.env.BROADCAST_ROLE || 'leader') === 'leader';
}
function reconcileEngine(phase) {
    const shouldRun = shouldDriveLifecycle() && phase === 'race_running';
    if (shouldRun && !isRunning())
        startEngine();
    if (!shouldRun && isRunning())
        stopEngine();
}
export function startCycleClock() {
    if (running)
        return;
    running = true;
    const sm = RaceState.getStateMachine();
    let lastPhase = null;
    unsubscribe = sm.subscribe((phase) => {
        if (phase === lastPhase)
            return;
        lastPhase = phase;
        reconcileEngine(phase);
        logEvent('cycle:phase', { phase });
    });
    MasterTimeline.setInterval(CLOCK_ID, INTERVAL_MS, () => {
        if (!running)
            return;
        if (!shouldDriveLifecycle()) {
            // Safety: ensure edges don't accidentally run the engine.
            if (isRunning())
                stopEngine();
            return;
        }
        // Reconcile engine even if only leadership changed.
        reconcileEngine(sm.state);
        try {
            sm.tick();
        }
        catch (e) {
            logEvent('cycle:tick-error', { error: e?.message ?? String(e) });
        }
    });
}
export function stopCycleClock() {
    running = false;
    MasterTimeline.clear(CLOCK_ID);
    if (unsubscribe) {
        try {
            unsubscribe();
        }
        catch {
            // ignore
        }
        unsubscribe = null;
    }
    if (isRunning())
        stopEngine();
}
export function isCycleClockRunning() {
    return running;
}
