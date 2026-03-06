class MasterTimelineImpl {
    timers = new Map();
    // One-shot schedule (Date or delay ms)
    schedule(id, whenMsOrDate, fn, raceId) {
        const delay = typeof whenMsOrDate === 'number'
            ? Math.max(0, whenMsOrDate)
            : Math.max(0, whenMsOrDate.getTime() - Date.now());
        this.clear(id);
        const ref = setTimeout(() => {
            try {
                fn();
            }
            finally {
                this.timers.delete(id);
            }
        }, delay);
        this.timers.set(id, { id, type: 'timeout', timerRef: ref, raceId });
    }
    // Repeating schedule
    setInterval(id, intervalMs, fn, raceId) {
        this.clear(id);
        const ref = setInterval(() => {
            fn();
        }, intervalMs);
        this.timers.set(id, { id, type: 'interval', timerRef: ref, raceId });
    }
    clear(id) {
        const entry = this.timers.get(id);
        if (!entry)
            return;
        if (entry.type === 'interval') {
            clearInterval(entry.timerRef);
        }
        else {
            clearTimeout(entry.timerRef);
        }
        this.timers.delete(id);
    }
    clearAllForRace(raceId) {
        for (const [id, entry] of this.timers.entries()) {
            if (entry.raceId === raceId) {
                this.clear(id);
            }
        }
    }
    shutdown() {
        for (const id of Array.from(this.timers.keys())) {
            this.clear(id);
        }
    }
    // Optional introspection for watchdog
    getTimerIds() {
        return Array.from(this.timers.keys());
    }
}
export const MasterTimeline = new MasterTimelineImpl();
