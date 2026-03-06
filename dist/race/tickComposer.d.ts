import type { FinalHorseStateMatrix } from './events/effects.js';
import type { EventTimeline, EventInstance } from './events/timeline.js';
export type BroadcastState = 'idle' | 'countdown' | 'racing' | 'results';
export type ComposedHorse = Readonly<{
    id: string;
    position: number;
    lane: number;
    speed: number;
    isStunned: boolean;
    isRemoved: boolean;
    activeEvents: ReadonlyArray<string>;
}>;
export type ComposedTick = Readonly<{
    tickIndex: number;
    timestamp: number;
    horses: ReadonlyArray<ComposedHorse>;
    events: ReadonlyArray<EventInstance>;
    state: BroadcastState;
}> & Readonly<Record<string, unknown>>;
/**
 * Compose broadcast-ready ticks from final horse states and event timeline.
 * - Immutable output (Object.freeze at all levels)
 * - Minimal cloning; per-tick arrays are newly created, pooled to reduce GC
 * - Time per tick composition target <= 0.1ms for typical sizes
 */
export declare function composeTicks(finalHorseStateMatrix: FinalHorseStateMatrix, eventTimeline: EventTimeline, tickDurationMs: number, metadata?: Readonly<Record<string, unknown>>): ReadonlyArray<ComposedTick>;
