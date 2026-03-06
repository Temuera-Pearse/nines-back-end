/**
 * Determine the race winner from the final horse state matrix.
 * - Single pass over ticks
 * - Deterministic tie-breaker (lexicographic horseId)
 * - Immutable output
 */
export function determineWinner(finalHorseStateMatrix, finishDistance, tickDurationMs) {
    const totalTicks = finalHorseStateMatrix.length;
    if (totalTicks === 0)
        return null;
    let firstCrossTick = -1;
    let crossingIds = null;
    for (let tickIndex = 0; tickIndex < totalTicks; tickIndex++) {
        const states = finalHorseStateMatrix[tickIndex];
        // Scan horses at this tick; gather those crossing
        // Avoid allocations until we find the first crossing tick
        let foundAny = false;
        for (let i = 0; i < states.length; i++) {
            // Use >= for exact finish crossing
            if (states[i].position >= finishDistance && !states[i].isRemoved) {
                foundAny = true;
                if (crossingIds === null)
                    crossingIds = [];
                crossingIds.push(states[i].horseId);
            }
        }
        if (foundAny) {
            firstCrossTick = tickIndex;
            break;
        }
    }
    if (firstCrossTick < 0 || !crossingIds || crossingIds.length === 0) {
        return null;
    }
    // Deterministic tie-breaker: smallest horseId lexicographically
    crossingIds.sort(); // in-place; tiny array
    const horseId = crossingIds[0];
    const timestampMs = firstCrossTick * tickDurationMs;
    return Object.freeze({
        horseId,
        tickIndex: firstCrossTick,
        timestampMs,
    });
}
// New: winner determination from precomputed crossing times only.
export function determineWinnerFromPrecomputed(pre) {
    // Find minimum crossing timestamp; skip non-finishers (missing time)
    const dtMs = pre.config.dtMs;
    let bestId = null;
    let bestMs = Number.POSITIVE_INFINITY;
    for (const h of pre.horses) {
        const ms = pre.finishTimesMs[h.id];
        if (typeof ms !== 'number')
            continue;
        if (ms < bestMs || (ms === bestMs && h.id < (bestId ?? h.id))) {
            bestMs = ms;
            bestId = h.id;
        }
    }
    if (!bestId || !isFinite(bestMs))
        return null;
    const tickIndex = Math.floor(bestMs / dtMs);
    return Object.freeze({
        horseId: bestId,
        tickIndex,
        timestampMs: bestMs,
    });
}
