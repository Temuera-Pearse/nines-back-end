import { PrecomputedRace } from './raceTypes.js';
import type { EventTimeline } from './events/timeline.js';
export declare function computeRaceChecksum(pre: PrecomputedRace): string;
export declare function computeEventTimelineHash(tl: EventTimeline): string;
