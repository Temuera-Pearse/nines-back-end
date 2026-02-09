export type EventCategory =
  | 'powerup'
  | 'combat'
  | 'environmental'
  | 'chaos'
  | 'chaos/meta'

export interface EventDefinition {
  id: string
  category: EventCategory
  durationTicks: number
  maxOccurrencesPerRace: number
  maxConcurrent: number
  conflictsWith: readonly string[]
  affectsMultipleHorses: boolean
  removesHorse: boolean
  exclusivePerHorse: boolean
}

// Reasonable defaults
const D = {
  short: 20, // 1s at 50ms ticks
  medium: 60, // 3s
  long: 120, // 6s
  occFew: 2,
  occSome: 3,
  occMany: 5,
  concLow: 1,
  concMed: 2,
  concHigh: 3,
} as const

// Base builder to ensure immutability
function def(e: EventDefinition): Readonly<EventDefinition> {
  return Object.freeze({
    ...e,
    conflictsWith: Object.freeze([...e.conflictsWith]),
  })
}

// Catalog entries
const EVENTS: Readonly<EventDefinition[]> = Object.freeze([
  // Combat
  def({
    id: 'hook_shot',
    category: 'combat',
    durationTicks: D.short,
    maxOccurrencesPerRace: D.occMany,
    maxConcurrent: D.concHigh,
    conflictsWith: ['temporary_shield', 'rocket_boost'],
    affectsMultipleHorses: false,
    removesHorse: false,
    exclusivePerHorse: true,
  }),
  def({
    id: 'bomb_throw',
    category: 'combat',
    durationTicks: D.medium,
    maxOccurrencesPerRace: D.occSome,
    maxConcurrent: D.concMed,
    conflictsWith: ['temporary_shield'],
    affectsMultipleHorses: true,
    removesHorse: false,
    exclusivePerHorse: false,
  }),
  def({
    id: 'position_swap',
    category: 'combat',
    durationTicks: D.short,
    maxOccurrencesPerRace: D.occFew,
    maxConcurrent: D.concLow,
    conflictsWith: ['magnet_pull', 'rocket_boost'],
    affectsMultipleHorses: true,
    removesHorse: false,
    exclusivePerHorse: true,
  }),
  def({
    id: 'samurai_duel',
    category: 'combat',
    durationTicks: D.medium,
    maxOccurrencesPerRace: D.occFew,
    maxConcurrent: D.concLow,
    conflictsWith: ['smg_attack'],
    affectsMultipleHorses: false,
    removesHorse: false,
    exclusivePerHorse: true,
  }),
  def({
    id: 'smg_attack',
    category: 'combat',
    durationTicks: D.medium,
    maxOccurrencesPerRace: D.occSome,
    maxConcurrent: D.concMed,
    conflictsWith: ['samurai_duel', 'temporary_shield'],
    affectsMultipleHorses: true,
    removesHorse: false,
    exclusivePerHorse: false,
  }),
  def({
    id: 'summon_lightning_strike',
    category: 'combat',
    durationTicks: D.short,
    maxOccurrencesPerRace: D.occSome,
    maxConcurrent: D.concMed,
    conflictsWith: ['temporary_shield', 'lightning_strike'],
    affectsMultipleHorses: false,
    removesHorse: false,
    exclusivePerHorse: false,
  }),
  def({
    id: 'aerial_duel',
    category: 'combat',
    durationTicks: D.medium,
    maxOccurrencesPerRace: D.occFew,
    maxConcurrent: D.concLow,
    conflictsWith: ['tornado', 'meteor_strike'],
    affectsMultipleHorses: true,
    removesHorse: false,
    exclusivePerHorse: false,
  }),

  // Environmental
  def({
    id: 'ice_patch',
    category: 'environmental',
    durationTicks: D.long,
    maxOccurrencesPerRace: D.occSome,
    maxConcurrent: D.concMed,
    conflictsWith: ['earthquake', 'tidal_wave'],
    affectsMultipleHorses: true,
    removesHorse: false,
    exclusivePerHorse: false,
  }),
  def({
    id: 'earthquake',
    category: 'environmental',
    durationTicks: D.medium,
    maxOccurrencesPerRace: D.occFew,
    maxConcurrent: D.concLow,
    conflictsWith: ['ice_patch', 'tornado'],
    affectsMultipleHorses: true,
    removesHorse: false,
    exclusivePerHorse: false,
  }),
  def({
    id: 'tidal_wave',
    category: 'environmental',
    durationTicks: D.medium,
    maxOccurrencesPerRace: D.occFew,
    maxConcurrent: D.concLow,
    conflictsWith: ['ice_patch'],
    affectsMultipleHorses: true,
    removesHorse: false,
    exclusivePerHorse: false,
  }),
  def({
    id: 'lightning_strike',
    category: 'environmental',
    durationTicks: D.short,
    maxOccurrencesPerRace: D.occSome,
    maxConcurrent: D.concMed,
    conflictsWith: ['summon_lightning_strike'],
    affectsMultipleHorses: false,
    removesHorse: false,
    exclusivePerHorse: false,
  }),
  def({
    id: 'meteor_strike',
    category: 'environmental',
    durationTicks: D.short,
    maxOccurrencesPerRace: D.occFew,
    maxConcurrent: D.concLow,
    conflictsWith: ['aerial_duel', 'rocket_boost'],
    affectsMultipleHorses: true,
    removesHorse: false,
    exclusivePerHorse: false,
  }),
  def({
    id: 'tornado',
    category: 'environmental',
    durationTicks: D.medium,
    maxOccurrencesPerRace: D.occFew,
    maxConcurrent: D.concLow,
    conflictsWith: ['earthquake', 'aerial_duel'],
    affectsMultipleHorses: true,
    removesHorse: false,
    exclusivePerHorse: false,
  }),

  // Powerups
  def({
    id: 'rocket_boost',
    category: 'powerup',
    durationTicks: D.medium,
    maxOccurrencesPerRace: D.occSome,
    maxConcurrent: D.concMed,
    conflictsWith: [
      'magnet_pull',
      'position_swap',
      'meteor_strike',
      'hook_shot',
    ],
    affectsMultipleHorses: false,
    removesHorse: false,
    exclusivePerHorse: true,
  }),
  def({
    id: 'temporary_shield',
    category: 'powerup',
    durationTicks: D.short,
    maxOccurrencesPerRace: D.occMany,
    maxConcurrent: D.concHigh,
    conflictsWith: ['smg_attack', 'bomb_throw', 'summon_lightning_strike'],
    affectsMultipleHorses: false,
    removesHorse: false,
    exclusivePerHorse: true,
  }),
  def({
    id: 'magnet_pull',
    category: 'powerup',
    durationTicks: D.short,
    maxOccurrencesPerRace: D.occSome,
    maxConcurrent: D.concMed,
    conflictsWith: ['rocket_boost', 'position_swap'],
    affectsMultipleHorses: true,
    removesHorse: false,
    exclusivePerHorse: false,
  }),

  // Chaos and meta
  def({
    id: 'ufo_abduction',
    category: 'chaos',
    durationTicks: D.short,
    maxOccurrencesPerRace: 1,
    maxConcurrent: D.concLow,
    conflictsWith: ['temporary_shield', 'rocket_boost', 'aerial_duel'],
    affectsMultipleHorses: false,
    removesHorse: true,
    exclusivePerHorse: true,
  }),
  def({
    id: 'chain_reaction',
    category: 'chaos',
    durationTicks: D.medium,
    maxOccurrencesPerRace: D.occFew,
    maxConcurrent: D.concLow,
    conflictsWith: ['temporary_shield'],
    affectsMultipleHorses: true,
    removesHorse: false,
    exclusivePerHorse: false,
  }),
  def({
    id: 'luck_charm',
    category: 'chaos/meta',
    durationTicks: D.long,
    maxOccurrencesPerRace: D.occFew,
    maxConcurrent: D.concMed,
    conflictsWith: [],
    affectsMultipleHorses: false,
    removesHorse: false,
    exclusivePerHorse: true,
  }),
])

// Immutable lookup map
const EVENT_MAP: ReadonlyMap<string, Readonly<EventDefinition>> = (() => {
  const m = new Map<string, Readonly<EventDefinition>>()
  for (const e of EVENTS) m.set(e.id, e)
  return m
})()

export const EVENT_CATALOG: Readonly<EventDefinition[]> = EVENTS

export function getEventById(
  id: string,
): Readonly<EventDefinition> | undefined {
  return EVENT_MAP.get(id)
}

export function canCoexist(
  eventA: Readonly<EventDefinition>,
  eventB: Readonly<EventDefinition>,
): boolean {
  if (eventA.id === eventB.id) {
    // Same event can coexist only if maxConcurrent > 1; decision left to scheduler,
    // but from coexist perspective, ensure no explicit conflict.
  }
  // Check direct conflicts both ways
  const aConflicts = eventA.conflictsWith.includes(eventB.id)
  const bConflicts = eventB.conflictsWith.includes(eventA.id)
  return !(aConflicts || bConflicts)
}

/**
 * Validate catalog conflict symmetry.
 * Ensures canCoexist(A,B) === canCoexist(B,A) for all pairs unless explicitly asymmetric.
 * Currently, we treat any asymmetry as a validation warning (no runtime change).
 */
export function validateCatalogSymmetry(
  catalog: Readonly<EventDefinition[]>,
): ReadonlyArray<{ a: string; b: string }> {
  const issues: Array<{ a: string; b: string }> = []
  for (let i = 0; i < catalog.length; i++) {
    for (let j = i + 1; j < catalog.length; j++) {
      const A = catalog[i]
      const B = catalog[j]
      const ab = canCoexist(A, B)
      const ba = canCoexist(B, A)
      if (ab !== ba) issues.push({ a: A.id, b: B.id })
    }
  }
  return Object.freeze(issues)
}
