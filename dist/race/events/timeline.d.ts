import type { EventDefinition } from './catalog.js';
export type EventInstance = Readonly<{
    id: string;
    tickIndex: number;
    instanceId: string;
}>;
export type EventTimeline = ReadonlyMap<number, Readonly<EventInstance[]>>;
export declare const MIN_SPACING_TICKS = 15;
export type RacePhaseId = 'early' | 'mid' | 'final';
export type RacePhase = Readonly<{
    id: RacePhaseId;
    startTick: number;
    endTick: number;
}>;
type WeightCategory = 'powerup' | 'combat' | 'environmental' | 'chaos';
export type PhaseWeights = Readonly<Record<WeightCategory, number>>;
export type PacingCurve = Readonly<Record<RacePhaseId, PhaseWeights>>;
export declare const PACING_CURVE: PacingCurve;
export type PhasePercents = Readonly<{
    earlyEndPct: number;
    midEndPct: number;
}>;
export type RampMode = 'none' | 'linear';
export type TimelineDebugEvent = {
    type: 'candidate';
    tickIndex: number;
    phase: RacePhaseId;
    eventId: string;
    category: WeightCategory;
    weight: number;
    normalizedScore: number;
    reason?: undefined;
} | {
    type: 'skip-weight-zero';
    tickIndex: number;
    phase: RacePhaseId;
    eventId: string;
    category: WeightCategory;
    weight: 0;
    normalizedScore: 0;
    reason: 'weight-zero';
};
export type GenerateTimelineOptions = Readonly<{
    pacingCurve?: PacingCurve;
    phasePercents?: PhasePercents;
    rampMode?: RampMode;
    debug?: {
        logger?: (e: TimelineDebugEvent) => void;
    };
}>;
export declare function getRacePhases(raceDurationTicks: number, percents?: PhasePercents): Readonly<RacePhase[]>;
export declare function getRacePhaseForTick(tick: number, raceDurationTicks: number, percents?: PhasePercents): RacePhaseId;
export declare function getPhaseWeightsForTick(tick: number, raceDurationTicks: number, pacingCurve?: PacingCurve, percents?: PhasePercents, rampMode?: RampMode): PhaseWeights;
export declare function getPerTickCategoryWeights(raceDurationTicks: number, options?: Readonly<{
    pacingCurve?: PacingCurve;
    phasePercents?: PhasePercents;
    rampMode?: RampMode;
}>): ReadonlyArray<Readonly<{
    tick: number;
    phase: RacePhaseId;
    weights: PhaseWeights;
}>>;
/**
 * Generate a deterministic timeline of events for a race.
 * - Uses only the provided seed (Mulberry32).
 * - Enforces per-event constraints and conflicts.
 * - Produces an immutable ReadonlyMap keyed by tickIndex.
 * - Integrates deterministic pacing curves to bias which events survive placement.
 */
export declare function generateEventTimeline(raceSeed: number, raceDurationTicks: number, catalog: Readonly<EventDefinition[]>, options?: GenerateTimelineOptions): EventTimeline;
export {};
