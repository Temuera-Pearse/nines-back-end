import type { EventDefinition } from './catalog.js';
import type { EventTimeline } from './timeline.js';
export type HorseBaseTick = Readonly<{
    horseId: string;
    position: number;
    lane: number;
    speed: number;
}>;
export type HorsePathMatrix = ReadonlyArray<ReadonlyArray<HorseBaseTick>>;
export type FinalHorseStateTick = Readonly<{
    horseId: string;
    position: number;
    lane: number;
    speed: number;
    isStunned: boolean;
    isRemoved: boolean;
    activeEvents: ReadonlyArray<string>;
}>;
export type FinalHorseStateMatrix = ReadonlyArray<ReadonlyArray<FinalHorseStateTick>>;
/**
 * Apply deterministic event effects over precomputed base paths.
 * Pure function: no randomness, no mutation, immutable output.
 */
export declare function applyEventEffects(baseHorsePaths: Readonly<HorsePathMatrix>, eventTimeline: Readonly<EventTimeline>, eventCatalog: Readonly<EventDefinition[]>): FinalHorseStateMatrix;
