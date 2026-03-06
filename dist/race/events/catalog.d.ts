export type EventCategory = 'powerup' | 'combat' | 'environmental' | 'chaos' | 'chaos/meta';
export interface EventDefinition {
    id: string;
    category: EventCategory;
    durationTicks: number;
    maxOccurrencesPerRace: number;
    maxConcurrent: number;
    conflictsWith: readonly string[];
    affectsMultipleHorses: boolean;
    removesHorse: boolean;
    exclusivePerHorse: boolean;
}
export declare const EVENT_CATALOG: Readonly<EventDefinition[]>;
export declare function getEventById(id: string): Readonly<EventDefinition> | undefined;
export declare function canCoexist(eventA: Readonly<EventDefinition>, eventB: Readonly<EventDefinition>): boolean;
/**
 * Validate catalog conflict symmetry.
 * Ensures canCoexist(A,B) === canCoexist(B,A) for all pairs unless explicitly asymmetric.
 * Currently, we treat any asymmetry as a validation warning (no runtime change).
 */
export declare function validateCatalogSymmetry(catalog: Readonly<EventDefinition[]>): ReadonlyArray<{
    a: string;
    b: string;
}>;
