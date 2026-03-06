import type { FinalHorseStateMatrix } from './events/effects.js';
import type { PrecomputedRace } from './raceTypes.js';
export type WinnerResult = Readonly<{
    horseId: string;
    tickIndex: number;
    timestampMs: number;
}>;
/**
 * Determine the race winner from the final horse state matrix.
 * - Single pass over ticks
 * - Deterministic tie-breaker (lexicographic horseId)
 * - Immutable output
 */
export declare function determineWinner(finalHorseStateMatrix: FinalHorseStateMatrix, finishDistance: number, tickDurationMs: number): WinnerResult | null;
export declare function determineWinnerFromPrecomputed(pre: PrecomputedRace): WinnerResult | null;
