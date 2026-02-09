type TimerType = 'timeout' | 'interval'

interface TimerEntry {
  id: string
  type: TimerType
  timerRef: NodeJS.Timeout
  raceId?: string
}

class MasterTimelineImpl {
  private timers = new Map<string, TimerEntry>()

  // One-shot schedule (Date or delay ms)
  schedule(
    id: string,
    whenMsOrDate: number | Date,
    fn: () => void,
    raceId?: string
  ): void {
    const delay =
      typeof whenMsOrDate === 'number'
        ? Math.max(0, whenMsOrDate)
        : Math.max(0, whenMsOrDate.getTime() - Date.now())
    this.clear(id)
    const ref = setTimeout(() => {
      try {
        fn()
      } finally {
        this.timers.delete(id)
      }
    }, delay)
    this.timers.set(id, { id, type: 'timeout', timerRef: ref, raceId })
  }

  // Repeating schedule
  setInterval(
    id: string,
    intervalMs: number,
    fn: () => void,
    raceId?: string
  ): void {
    this.clear(id)
    const ref = setInterval(() => {
      fn()
    }, intervalMs)
    this.timers.set(id, { id, type: 'interval', timerRef: ref, raceId })
  }

  clear(id: string): void {
    const entry = this.timers.get(id)
    if (!entry) return
    if (entry.type === 'interval') {
      clearInterval(entry.timerRef)
    } else {
      clearTimeout(entry.timerRef)
    }
    this.timers.delete(id)
  }

  clearAllForRace(raceId: string): void {
    for (const [id, entry] of this.timers.entries()) {
      if (entry.raceId === raceId) {
        this.clear(id)
      }
    }
  }

  shutdown(): void {
    for (const id of Array.from(this.timers.keys())) {
      this.clear(id)
    }
  }

  // Optional introspection for watchdog
  getTimerIds(): string[] {
    return Array.from(this.timers.keys())
  }
}

export const MasterTimeline = new MasterTimelineImpl()
